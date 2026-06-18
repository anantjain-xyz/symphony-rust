use async_trait::async_trait;
use reqwest::{header::RETRY_AFTER, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;
use symphony_core::{Issue, LinearProjectRef, TrackerConfig};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TrackerError {
    #[error("Linear auth failed: {0}")]
    Auth(String),
    #[error("Linear rate limited; retry after {retry_after_ms}ms")]
    RateLimit { retry_after_ms: u64 },
    #[error("Linear request timed out after {0}ms")]
    Timeout(u64),
    #[error("Linear issue not found")]
    NotFound,
    #[error("Linear HTTP error {status}: {message}")]
    Http { status: StatusCode, message: String },
    #[error("Linear GraphQL error: {0}")]
    Graphql(String),
    #[error("Linear transport error: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("invalid Linear response: {0}")]
    Invalid(String),
}

#[async_trait]
pub trait TrackerClient: Send + Sync {
    async fn preflight(&self) -> Result<(), TrackerError>;
    async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError>;
    async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError>;
    async fn fetch_by_id(&self, id: &str) -> Result<Option<Issue>, TrackerError>;
}

#[derive(Debug, Clone)]
pub struct LinearTracker {
    config: TrackerConfig,
    client: reqwest::Client,
    request_timeout_ms: u64,
    max_attempts: usize,
}

impl LinearTracker {
    pub fn new(config: TrackerConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
            request_timeout_ms: 15_000,
            max_attempts: 3,
        }
    }

    pub fn with_resilience(mut self, request_timeout_ms: u64, max_attempts: usize) -> Self {
        self.request_timeout_ms = request_timeout_ms;
        self.max_attempts = max_attempts.max(1);
        self
    }

    pub async fn viewer(&self) -> Result<LinearViewer, TrackerError> {
        let data: ViewerData = self.execute(VIEWER_QUERY, None).await?;
        Ok(data.viewer)
    }

    /// The Linear team key derived from the configured identifier prefix.
    /// Accepts either form — `WAL` or `WAL-` — by trimming an optional
    /// trailing hyphen.
    fn team_key_from_prefix(&self) -> Option<String> {
        self.config
            .identifier_prefix
            .as_ref()
            .map(|prefix| prefix.strip_suffix('-').unwrap_or(prefix))
            .filter(|key| !key.is_empty())
            .map(ToOwned::to_owned)
    }

    /// The full prefix used to match issue identifiers like `WAL-123`, always
    /// normalized to include the trailing hyphen so a bare `WAL` doesn't also
    /// match other teams such as `WALLET-`.
    fn identifier_match_prefix(&self) -> Option<String> {
        self.team_key_from_prefix().map(|key| format!("{key}-"))
    }

    fn filter_by_prefix(&self, mut issues: Vec<Issue>) -> Vec<Issue> {
        if let Some(prefix) = self.identifier_match_prefix() {
            issues.retain(|issue| issue.identifier.starts_with(&prefix));
        }
        issues
    }

    fn project_ref(&self) -> Option<LinearProjectRef> {
        self.config
            .project_id
            .as_deref()
            .and_then(LinearProjectRef::parse)
    }

    async fn fetch_by_state_names(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError> {
        if states.is_empty() {
            return Ok(Vec::new());
        }
        let mut var_decls = Vec::new();
        let mut or_clauses = Vec::new();
        let mut variables = serde_json::Map::new();
        for (idx, state) in states.iter().enumerate() {
            let name = format!("s{idx}");
            var_decls.push(format!("${name}: String!"));
            or_clauses.push(format!(
                "{{ state: {{ name: {{ eqIgnoreCase: ${name} }} }} }}"
            ));
            variables.insert(name, serde_json::Value::String(state.clone()));
        }
        let mut filter_parts = vec![format!("or: [{}]", or_clauses.join(", "))];
        if let Some(team_key) = self.team_key_from_prefix() {
            var_decls.push("$teamKey: String!".to_string());
            filter_parts.push("team: { key: { eq: $teamKey } }".to_string());
            variables.insert("teamKey".to_string(), serde_json::Value::String(team_key));
        }
        if let Some(project_ref) = self.project_ref() {
            if let Some(project_id) = project_ref.id() {
                var_decls.push("$projectId: ID!".to_string());
                filter_parts.push("project: { id: { eq: $projectId } }".to_string());
                variables.insert(
                    "projectId".to_string(),
                    serde_json::Value::String(project_id.to_string()),
                );
            } else if let Some(project_slug_id) = project_ref.slug_id() {
                var_decls.push("$projectSlugId: String!".to_string());
                filter_parts.push("project: { slugId: { eq: $projectSlugId } }".to_string());
                variables.insert(
                    "projectSlugId".to_string(),
                    serde_json::Value::String(project_slug_id.to_string()),
                );
            }
        }
        let filter = filter_parts.join(", ");
        if self.config.assigned_to_me {
            let query = format!(
                r#"
                query SymphonyIssuesByState({}) {{
                  viewer {{
                    assignedIssues(filter: {{ {} }}, first: 100) {{
                      nodes {{ {} }}
                    }}
                  }}
                }}
                "#,
                var_decls.join(", "),
                filter,
                ISSUE_FIELDS
            );
            let data: AssignedIssuesByStateData =
                self.execute(&query, Some(variables.into())).await?;
            return Ok(data
                .viewer
                .assigned_issues
                .nodes
                .into_iter()
                .map(normalize)
                .collect());
        }

        let query = format!(
            r#"
            query SymphonyIssuesByState({}) {{
              issues(filter: {{ {} }}, first: 100) {{
                nodes {{ {} }}
              }}
            }}
            "#,
            var_decls.join(", "),
            filter,
            ISSUE_FIELDS
        );
        let data: IssuesByStateData = self.execute(&query, Some(variables.into())).await?;
        Ok(data.issues.nodes.into_iter().map(normalize).collect())
    }

    async fn execute<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: Option<serde_json::Value>,
    ) -> Result<T, TrackerError> {
        let mut last_error: Option<TrackerError> = None;
        for attempt in 1..=self.max_attempts {
            match self.try_once(query, variables.clone()).await {
                Ok(value) => return Ok(value),
                Err(err) if attempt < self.max_attempts && err.is_retryable() => {
                    let delay_ms = err.retry_delay_ms(attempt);
                    last_error = Some(err);
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
                Err(err) => return Err(err),
            }
        }
        Err(last_error.unwrap_or_else(|| TrackerError::Invalid("no attempts made".to_string())))
    }

    async fn try_once<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: Option<serde_json::Value>,
    ) -> Result<T, TrackerError> {
        let req = GraphqlRequest { query, variables };
        let response = self
            .client
            .post(&self.config.endpoint)
            // Linear personal API keys are sent as the raw Authorization value,
            // with no "Bearer " prefix (that prefix is only for OAuth tokens).
            .header(reqwest::header::AUTHORIZATION, self.config.api_key.as_str())
            .timeout(Duration::from_millis(self.request_timeout_ms))
            .json(&req)
            .send()
            .await
            .map_err(|err| {
                if err.is_timeout() {
                    TrackerError::Timeout(self.request_timeout_ms)
                } else {
                    TrackerError::Transport(err)
                }
            })?;

        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(TrackerError::Auth(status.to_string()));
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(TrackerError::RateLimit {
                retry_after_ms: retry_after_ms(&response),
            });
        }
        if !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(TrackerError::Http { status, message });
        }

        let payload: GraphqlResponse<T> = response.json().await?;
        if let Some(errors) = payload.errors {
            if errors.iter().any(GraphqlError::is_not_found) {
                return Err(TrackerError::NotFound);
            }
            return Err(TrackerError::Graphql(
                errors
                    .into_iter()
                    .map(|err| err.message)
                    .collect::<Vec<_>>()
                    .join("; "),
            ));
        }
        payload
            .data
            .ok_or_else(|| TrackerError::Invalid("missing data".to_string()))
    }
}

#[async_trait]
impl TrackerClient for LinearTracker {
    async fn preflight(&self) -> Result<(), TrackerError> {
        self.viewer().await?;
        Ok(())
    }

    async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
        let mut issues = self.filter_by_prefix(
            self.fetch_by_state_names(&self.config.active_states)
                .await?,
        );
        issues.sort_by(by_priority_then_identifier);
        Ok(issues)
    }

    async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
        Ok(self.filter_by_prefix(
            self.fetch_by_state_names(&self.config.terminal_states)
                .await?,
        ))
    }

    async fn fetch_by_id(&self, id: &str) -> Result<Option<Issue>, TrackerError> {
        let variables = serde_json::json!({ "id": id });
        let data = match self
            .execute::<IssueByIdData>(ISSUE_BY_ID_QUERY, Some(variables))
            .await
        {
            Ok(data) => data,
            Err(TrackerError::NotFound) => return Ok(None),
            Err(err) => return Err(err),
        };
        let Some(node) = data.issue else {
            return Ok(None);
        };
        if self.config.assigned_to_me {
            let viewer = self.viewer().await?;
            if node.assignee.as_ref().map(|user| user.id.as_str()) != Some(viewer.id.as_str()) {
                return Ok(None);
            }
        }
        if let Some(project_ref) = self.project_ref() {
            let project_id = node.project.as_ref().map(|p| p.id.as_str());
            let project_slug_id = node.project.as_ref().and_then(|p| p.slug_id.as_deref());
            if !project_ref.matches_project(project_id, project_slug_id) {
                return Ok(None);
            }
        }
        let issue = normalize(node);
        if let Some(prefix) = self.identifier_match_prefix() {
            if !issue.identifier.starts_with(&prefix) {
                return Ok(None);
            }
        }
        Ok(Some(issue))
    }
}

impl TrackerError {
    fn is_retryable(&self) -> bool {
        match self {
            Self::RateLimit { .. } | Self::Timeout(_) | Self::Transport(_) => true,
            Self::Http { status, .. } => status.is_server_error(),
            _ => false,
        }
    }

    fn retry_delay_ms(&self, attempt: usize) -> u64 {
        match self {
            Self::RateLimit { retry_after_ms } => retry_after_ms.saturating_add(100),
            _ => (500_u64 * 2_u64.saturating_pow((attempt - 1) as u32)).min(5_000),
        }
    }
}

fn retry_after_ms(response: &reqwest::Response) -> u64 {
    response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.parse::<u64>().ok())
        .map(|seconds| seconds * 1000)
        .unwrap_or(5_000)
}

fn by_priority_then_identifier(a: &Issue, b: &Issue) -> std::cmp::Ordering {
    let pa = if a.priority == 0 { 99 } else { a.priority };
    let pb = if b.priority == 0 { 99 } else { b.priority };
    pa.cmp(&pb).then_with(|| a.identifier.cmp(&b.identifier))
}

#[derive(Serialize)]
struct GraphqlRequest<'a> {
    query: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    variables: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct GraphqlResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GraphqlError>>,
}

#[derive(Deserialize)]
struct GraphqlError {
    message: String,
    extensions: Option<GraphqlErrorExtensions>,
}

impl GraphqlError {
    fn is_not_found(&self) -> bool {
        self.extensions.as_ref().and_then(|ext| ext.code.as_deref()) == Some("INPUT_ERROR")
            && self.message.starts_with("Entity not found")
    }
}

#[derive(Deserialize)]
struct GraphqlErrorExtensions {
    code: Option<String>,
}

#[derive(Deserialize)]
struct ViewerData {
    viewer: LinearViewer,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinearViewer {
    pub id: String,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
}

#[derive(Deserialize)]
struct IssuesByStateData {
    issues: LinearIssueConnection,
}

#[derive(Deserialize)]
struct AssignedIssuesByStateData {
    viewer: AssignedIssueViewer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssignedIssueViewer {
    assigned_issues: LinearIssueConnection,
}

#[derive(Deserialize)]
struct IssueByIdData {
    issue: Option<LinearIssueNode>,
}

#[derive(Deserialize)]
struct LinearIssueConnection {
    nodes: Vec<LinearIssueNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinearIssueNode {
    id: String,
    identifier: String,
    title: String,
    description: Option<String>,
    priority: i16,
    branch_name: Option<String>,
    state: Option<LinearState>,
    project: Option<LinearProject>,
    assignee: Option<LinearAssignee>,
    labels: Option<LinearLabelConnection>,
    inverse_relations: Option<LinearRelationConnection>,
    attachments: Option<LinearAttachmentConnection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinearProject {
    id: String,
    slug_id: Option<String>,
}

#[derive(Deserialize)]
struct LinearState {
    name: Option<String>,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    state_type: Option<String>,
}

#[derive(Deserialize)]
struct LinearAssignee {
    id: String,
}

#[derive(Deserialize)]
struct LinearLabelConnection {
    nodes: Vec<LinearLabel>,
}

#[derive(Deserialize)]
struct LinearLabel {
    name: String,
}

#[derive(Deserialize)]
struct LinearRelationConnection {
    nodes: Vec<LinearRelation>,
}

#[derive(Deserialize)]
struct LinearRelation {
    #[serde(rename = "type")]
    relation_type: String,
    issue: Option<LinearRelationIssue>,
}

#[derive(Deserialize)]
struct LinearRelationIssue {
    identifier: String,
    state: Option<LinearRelationState>,
}

#[derive(Deserialize)]
struct LinearRelationState {
    #[serde(rename = "type")]
    state_type: Option<String>,
}

#[derive(Deserialize)]
struct LinearAttachmentConnection {
    nodes: Vec<LinearAttachment>,
}

#[derive(Deserialize)]
struct LinearAttachment {
    url: String,
}

fn normalize(node: LinearIssueNode) -> Issue {
    let state = node
        .state
        .and_then(|state| state.name)
        .unwrap_or_else(|| "unknown".to_string())
        .to_lowercase();
    let blockers = node
        .inverse_relations
        .map(|relations| {
            relations
                .nodes
                .into_iter()
                .filter(|rel| rel.relation_type == "blocks")
                .filter_map(|rel| rel.issue)
                .filter(|issue| {
                    !matches!(
                        issue.state.as_ref().and_then(|s| s.state_type.as_deref()),
                        Some("completed" | "canceled")
                    )
                })
                .map(|issue| issue.identifier)
                .collect()
        })
        .unwrap_or_default();
    let pr_urls = node
        .attachments
        .map(|attachments| {
            attachments
                .nodes
                .into_iter()
                .map(|attachment| attachment.url)
                .filter(|url| is_github_pr_url(url))
                .collect()
        })
        .unwrap_or_default();
    Issue {
        id: node.id,
        identifier: node.identifier,
        title: node.title,
        description: node.description,
        priority: node.priority,
        state,
        branch: node.branch_name,
        labels: node
            .labels
            .map(|labels| labels.nodes.into_iter().map(|label| label.name).collect())
            .unwrap_or_default(),
        blockers,
        pr_urls,
        project_id: node.project.as_ref().map(|project| project.id.clone()),
        project_slug_id: node.project.and_then(|project| project.slug_id),
    }
}

fn is_github_pr_url(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
    else {
        return false;
    };
    let parts: Vec<_> = rest.split('/').collect();
    parts.len() >= 4 && parts[2] == "pull" && parts[3].parse::<u64>().is_ok()
}

const ISSUE_FIELDS: &str = r#"
  id
  identifier
  title
  description
  priority
  branchName
  state { name }
  project { id slugId }
  assignee { id }
  labels { nodes { name } }
  inverseRelations {
    nodes {
      type
      issue {
        identifier
        state { type }
      }
    }
  }
  attachments { nodes { url } }
"#;

const VIEWER_QUERY: &str = r#"
  query SymphonyPreflight {
    viewer { id name displayName email }
  }
"#;

const ISSUE_BY_ID_QUERY: &str = r#"
  query SymphonyIssueById($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      priority
      branchName
      state { name }
      project { id slugId }
      assignee { id }
      labels { nodes { name } }
      inverseRelations {
        nodes {
          type
          issue {
            identifier
            state { type }
          }
        }
      }
      attachments { nodes { url } }
    }
  }
"#;

#[derive(Debug, Clone)]
pub struct StaticTracker {
    pub active: Vec<Issue>,
    pub terminal: Vec<Issue>,
}

#[async_trait]
impl TrackerClient for StaticTracker {
    async fn preflight(&self) -> Result<(), TrackerError> {
        Ok(())
    }

    async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
        Ok(self.active.clone())
    }

    async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
        Ok(self.terminal.clone())
    }

    async fn fetch_by_id(&self, id: &str) -> Result<Option<Issue>, TrackerError> {
        Ok(self
            .active
            .iter()
            .chain(self.terminal.iter())
            .find(|issue| issue.id == id)
            .cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_github_pr_urls() {
        assert!(is_github_pr_url("https://github.com/a/b/pull/123"));
        assert!(!is_github_pr_url("https://github.com/a/b/issues/123"));
    }

    fn tracker_with_prefix(prefix: Option<&str>) -> LinearTracker {
        LinearTracker::new(TrackerConfig {
            identifier_prefix: prefix.map(ToOwned::to_owned),
            ..Default::default()
        })
    }

    #[test]
    fn prefix_accepts_either_form() {
        for raw in ["WAL", "WAL-"] {
            let tracker = tracker_with_prefix(Some(raw));
            assert_eq!(tracker.team_key_from_prefix().as_deref(), Some("WAL"));
            assert_eq!(tracker.identifier_match_prefix().as_deref(), Some("WAL-"));
        }

        // The hyphenated match prefix guards against matching other teams.
        let tracker = tracker_with_prefix(Some("WAL"));
        let prefix = tracker.identifier_match_prefix().unwrap();
        assert!("WAL-123".starts_with(&prefix));
        assert!(!"WALLET-5".starts_with(&prefix));
    }

    #[test]
    fn prefix_absent_or_empty_yields_no_filter() {
        for raw in [None, Some(""), Some("-")] {
            let tracker = tracker_with_prefix(raw);
            assert_eq!(tracker.team_key_from_prefix(), None);
            assert_eq!(tracker.identifier_match_prefix(), None);
        }
    }

    #[test]
    fn project_ref_accepts_linear_project_urls() {
        let tracker = LinearTracker::new(TrackerConfig {
            project_id: Some(
                "https://linear.app/optimism-llc/project/phase-1-pre-launch-fixes-00bdaf30dd39/overview"
                    .to_string(),
            ),
            ..Default::default()
        });

        assert_eq!(
            tracker
                .project_ref()
                .and_then(|project| { project.slug_id().map(str::to_string) }),
            Some("phase-1-pre-launch-fixes-00bdaf30dd39".to_string())
        );
    }
}
