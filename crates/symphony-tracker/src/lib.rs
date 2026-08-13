use async_trait::async_trait;
use reqwest::{header::RETRY_AFTER, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
use symphony_core::{Issue, LinearProjectRef, TrackerConfig};
use thiserror::Error;

/// Process-wide reqwest client. `reqwest::Client` is an Arc internally and is
/// meant to be reused so its connection pool is shared; building one per request
/// (e.g. the 15s board poll) would leak connections and add TLS handshakes.
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn shared_http_client() -> reqwest::Client {
    HTTP_CLIENT.get_or_init(reqwest::Client::new).clone()
}

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
    async fn fetch_by_id_for_dispatch(&self, id: &str) -> Result<Option<Issue>, TrackerError> {
        self.fetch_by_id(id).await
    }
    async fn fetch_workpads(
        &self,
        issue_ids: &[String],
    ) -> Result<Vec<WorkpadComment>, TrackerError>;
    /// Workflow states (columns) for the configured team, ordered by position.
    /// Defaults to empty for trackers that do not model workflow states.
    async fn list_workflow_states(&self) -> Result<Vec<WorkflowState>, TrackerError> {
        Ok(Vec::new())
    }
    /// Move an issue to a new workflow state. Defaults to unsupported.
    async fn set_issue_state(&self, _issue_id: &str, _state_id: &str) -> Result<(), TrackerError> {
        Err(TrackerError::Invalid(
            "changing issue state is not supported by this tracker".to_string(),
        ))
    }
    /// Move an issue to a workflow state resolved by name from its own team.
    /// Defaults to unsupported.
    async fn set_issue_state_by_name(
        &self,
        _issue_id: &str,
        _state_name: &str,
    ) -> Result<(), TrackerError> {
        Err(TrackerError::Invalid(
            "changing issue state by name is not supported by this tracker".to_string(),
        ))
    }
    /// All issues for the configured team/project across every state (board view).
    async fn fetch_board_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        Ok(Vec::new())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkpadComment {
    pub issue_id: String,
    pub comment_id: String,
    pub body: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
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
            client: shared_http_client(),
            request_timeout_ms: 15_000,
            max_attempts: 3,
        }
    }

    pub async fn viewer(&self) -> Result<LinearViewer, TrackerError> {
        let data: ViewerData = self.execute(VIEWER_QUERY, None).await?;
        Ok(data.viewer)
    }

    fn team_keys(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        self.config
            .team_keys
            .iter()
            .map(|key| key.trim().trim_end_matches('-').to_ascii_uppercase())
            .filter(|key| !key.is_empty() && seen.insert(key.clone()))
            .collect()
    }

    fn project_refs(&self) -> Vec<LinearProjectRef> {
        let mut seen = std::collections::HashSet::new();
        self.config
            .project_ids
            .iter()
            .filter_map(|value| LinearProjectRef::parse(value))
            .filter(|project| seen.insert(project.canonical_key()))
            .collect()
    }

    /// Apply the same OR-within/AND-across semantics as the server query. This
    /// is a defensive guard for direct issue fetches and API responses.
    fn filter_issues(&self, mut issues: Vec<Issue>) -> Vec<Issue> {
        let team_keys = self.team_keys();
        let project_refs = self.project_refs();
        issues.retain(|issue| {
            let team_matches = team_keys.is_empty()
                || issue.identifier.split_once('-').is_some_and(|(team, _)| {
                    team_keys.iter().any(|key| key.eq_ignore_ascii_case(team))
                });
            let project_matches = project_refs.is_empty()
                || project_refs.iter().any(|project| {
                    project.matches_project(
                        issue.project_id.as_deref(),
                        issue.project_slug_id.as_deref(),
                    )
                });
            team_matches && project_matches
        });
        issues
    }

    fn push_scope_filters(
        &self,
        var_decls: &mut Vec<String>,
        filter_parts: &mut Vec<String>,
        variables: &mut serde_json::Map<String, serde_json::Value>,
    ) {
        let team_keys = self.team_keys();
        if !team_keys.is_empty() {
            var_decls.push("$teamKeys: [String!]!".to_string());
            filter_parts.push("team: { key: { in: $teamKeys } }".to_string());
            variables.insert("teamKeys".to_string(), serde_json::json!(team_keys));
        }

        let project_refs = self.project_refs();
        let project_ids = project_refs
            .iter()
            .filter_map(LinearProjectRef::id)
            .collect::<Vec<_>>();
        let project_slug_ids = project_refs
            .iter()
            .filter_map(LinearProjectRef::slug_id)
            .collect::<Vec<_>>();
        let mut project_filters = Vec::new();
        if !project_ids.is_empty() {
            var_decls.push("$projectIds: [ID!]!".to_string());
            variables.insert("projectIds".to_string(), serde_json::json!(project_ids));
            project_filters.push("{ id: { in: $projectIds } }".to_string());
        }
        for (index, project_slug_id) in project_slug_ids.iter().enumerate() {
            let variable = if project_slug_ids.len() == 1 {
                "projectSlugId".to_string()
            } else {
                format!("projectSlugId{index}")
            };
            var_decls.push(format!("${variable}: String!"));
            variables.insert(variable.clone(), serde_json::json!(project_slug_id));
            project_filters.push(format!("{{ slugId: {{ eq: ${variable} }} }}"));
        }
        match project_filters.as_slice() {
            [] => {}
            [only] => filter_parts.push(format!("project: {only}")),
            many => filter_parts.push(format!("project: {{ or: [{}] }}", many.join(", "))),
        }
    }

    async fn fetch_by_state_names(
        &self,
        states: &[String],
        assigned_to_me: bool,
    ) -> Result<Vec<Issue>, TrackerError> {
        let Some(prepared) = self
            .build_issues_by_state_query(states, assigned_to_me)
            .await?
        else {
            return Ok(Vec::new());
        };

        let mut nodes = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..50 {
            let mut variables = prepared.variables.clone();
            if let serde_json::Value::Object(map) = &mut variables {
                map.insert(
                    "cursor".to_string(),
                    cursor
                        .as_deref()
                        .map(|value| serde_json::Value::String(value.to_string()))
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            let data: IssuesByStateData = self.execute(&prepared.query, Some(variables)).await?;
            let page = data.issues.page_info;
            nodes.extend(data.issues.nodes);
            match page {
                Some(page) if page.has_next_page => {
                    let Some(next) = page.end_cursor else { break };
                    cursor = Some(next);
                }
                _ => break,
            }
        }
        Ok(nodes.into_iter().map(normalize).collect())
    }

    async fn build_issues_by_state_query(
        &self,
        states: &[String],
        assigned_to_me: bool,
    ) -> Result<Option<PreparedIssuesQuery>, TrackerError> {
        if states.is_empty() {
            return Ok(None);
        }

        let assignee_id = if assigned_to_me {
            Some(self.viewer().await?.id)
        } else {
            None
        };

        Ok(self.build_issues_by_state_query_for_assignee(states, assignee_id.as_deref()))
    }

    fn build_issues_by_state_query_for_assignee(
        &self,
        states: &[String],
        assignee_id: Option<&str>,
    ) -> Option<PreparedIssuesQuery> {
        if states.is_empty() {
            return None;
        }

        let mut var_decls = vec!["$cursor: String".to_string()];
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
        self.push_scope_filters(&mut var_decls, &mut filter_parts, &mut variables);
        if let Some(assignee_id) = assignee_id {
            var_decls.push("$assigneeId: ID!".to_string());
            filter_parts.push("assignee: { id: { eq: $assigneeId } }".to_string());
            variables.insert(
                "assigneeId".to_string(),
                serde_json::Value::String(assignee_id.to_string()),
            );
        }
        let filter = filter_parts.join(", ");
        let query = format!(
            r#"
            query SymphonyIssuesByState({}) {{
              issues(filter: {{ {} }}, first: 100, after: $cursor) {{
                nodes {{ {} }}
                pageInfo {{ hasNextPage endCursor }}
              }}
            }}
            "#,
            var_decls.join(", "),
            filter,
            ISSUE_FIELDS
        );
        Some(PreparedIssuesQuery {
            query,
            variables: variables.into(),
        })
    }

    fn build_board_issues_query(&self) -> PreparedIssuesQuery {
        // No state filter: the board wants every issue for the configured scope so it can
        // populate lanes (e.g. In Review) that are not in the watched dispatch states.
        // Paginated (250 per page) via `after: $cursor`; callers must scope by a
        // team/project so this never fans out to the whole workspace.
        let mut var_decls = vec!["$cursor: String".to_string()];
        let mut filter_parts = Vec::new();
        let mut variables = serde_json::Map::new();
        self.push_scope_filters(&mut var_decls, &mut filter_parts, &mut variables);
        let filter = filter_parts.join(", ");
        let query = format!(
            r#"
            query SymphonyBoardIssues({}) {{
              issues(filter: {{ {} }}, first: 250, after: $cursor) {{
                nodes {{ {} }}
                pageInfo {{ hasNextPage endCursor }}
              }}
            }}
            "#,
            var_decls.join(", "),
            filter,
            ISSUE_FIELDS
        );
        PreparedIssuesQuery {
            query,
            variables: variables.into(),
        }
    }

    async fn fetch_by_id_inner(
        &self,
        id: &str,
        assigned_to_me: bool,
    ) -> Result<Option<Issue>, TrackerError> {
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
        if assigned_to_me {
            let viewer = self.viewer().await?;
            if node.assignee.as_ref().map(|user| user.id.as_str()) != Some(viewer.id.as_str()) {
                return Ok(None);
            }
        }
        let issue = normalize(node);
        Ok(self.filter_issues(vec![issue]).into_iter().next())
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
        let mut issues = self.filter_issues(
            self.fetch_by_state_names(&self.config.active_states, self.config.assigned_to_me)
                .await?,
        );
        issues.sort_by(by_priority_then_identifier);
        Ok(issues)
    }

    async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
        Ok(self.filter_issues(
            self.fetch_by_state_names(&self.config.terminal_states, false)
                .await?,
        ))
    }

    async fn fetch_by_id(&self, id: &str) -> Result<Option<Issue>, TrackerError> {
        self.fetch_by_id_inner(id, false).await
    }

    async fn fetch_by_id_for_dispatch(&self, id: &str) -> Result<Option<Issue>, TrackerError> {
        self.fetch_by_id_inner(id, self.config.assigned_to_me).await
    }

    async fn list_workflow_states(&self) -> Result<Vec<WorkflowState>, TrackerError> {
        // Linear workflow state IDs belong to one team. Showing one team's IDs
        // for a multi-team board would make drag-to-move invalid for issues from
        // every other team, so enable state-aware lanes only for a single team.
        let team_keys = self.team_keys();
        let [team_key] = team_keys.as_slice() else {
            return Ok(Vec::new());
        };
        let variables = serde_json::json!({ "teamKey": team_key });
        let data: WorkflowStatesData = self.execute(WORKFLOW_STATES_QUERY, Some(variables)).await?;
        let mut states = data.workflow_states.nodes;
        states.sort_by(|a, b| {
            a.position
                .partial_cmp(&b.position)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(states)
    }

    async fn set_issue_state(&self, issue_id: &str, state_id: &str) -> Result<(), TrackerError> {
        let variables = serde_json::json!({ "id": issue_id, "stateId": state_id });
        let data: IssueUpdateData = self
            .execute(SET_ISSUE_STATE_MUTATION, Some(variables))
            .await?;
        if !data.issue_update.success {
            return Err(TrackerError::Invalid(
                "Linear rejected the issue state change".to_string(),
            ));
        }
        Ok(())
    }

    async fn set_issue_state_by_name(
        &self,
        issue_id: &str,
        state_name: &str,
    ) -> Result<(), TrackerError> {
        let variables = serde_json::json!({ "id": issue_id });
        let data: IssueWorkflowStatesData = self
            .execute(ISSUE_WORKFLOW_STATES_QUERY, Some(variables))
            .await?;
        let issue = data.issue.ok_or(TrackerError::NotFound)?;
        let state = issue
            .team
            .states
            .nodes
            .into_iter()
            .find(|state| state.name.eq_ignore_ascii_case(state_name))
            .ok_or_else(|| {
                TrackerError::Invalid(format!(
                    "workflow state `{state_name}` was not found for issue {issue_id}"
                ))
            })?;
        self.set_issue_state(issue_id, &state.id).await
    }

    async fn fetch_board_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        // Never fetch the entire workspace: require a team or project scope.
        if self.team_keys().is_empty() && self.project_refs().is_empty() {
            return Ok(Vec::new());
        }
        let prepared = self.build_board_issues_query();
        let mut nodes = Vec::new();
        let mut cursor: Option<String> = None;
        // Page through the whole board (250/page) so large teams aren't truncated.
        // Cap the page count defensively against a pathological pageInfo loop.
        for _ in 0..50 {
            let mut variables = prepared.variables.clone();
            if let serde_json::Value::Object(map) = &mut variables {
                map.insert(
                    "cursor".to_string(),
                    cursor
                        .as_deref()
                        .map(|value| serde_json::Value::String(value.to_string()))
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            let data: IssuesByStateData = self.execute(&prepared.query, Some(variables)).await?;
            let page = data.issues.page_info;
            nodes.extend(data.issues.nodes);
            match page {
                Some(page) if page.has_next_page => {
                    let Some(next) = page.end_cursor else { break };
                    cursor = Some(next);
                }
                _ => break,
            }
        }
        let mut issues = self.filter_issues(nodes.into_iter().map(normalize).collect());
        issues.sort_by(by_priority_then_identifier);
        Ok(issues)
    }

    async fn fetch_workpads(
        &self,
        issue_ids: &[String],
    ) -> Result<Vec<WorkpadComment>, TrackerError> {
        let mut workpads = Vec::new();
        for issue_id in issue_ids {
            if let Some(workpad) = self.fetch_workpad(issue_id).await? {
                workpads.push(workpad);
            }
        }
        Ok(workpads)
    }
}

impl LinearTracker {
    async fn fetch_workpad(&self, issue_id: &str) -> Result<Option<WorkpadComment>, TrackerError> {
        let mut comments_cursor: Option<String> = None;
        loop {
            let variables = serde_json::json!({
                "id": issue_id,
                "commentsCursor": comments_cursor,
            });
            let data = match self
                .execute::<IssueCommentsData>(ISSUE_COMMENTS_QUERY, Some(variables))
                .await
            {
                Ok(data) => data,
                Err(TrackerError::NotFound) => return Ok(None),
                Err(err) => return Err(err),
            };
            let Some(issue) = data.issue else {
                return Ok(None);
            };
            let mut comments = issue.comments.nodes;
            comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
            if let Some(comment) = comments
                .into_iter()
                .find(|comment| comment.body.trim_start().starts_with("## Symphony Workpad"))
            {
                return Ok(Some(WorkpadComment {
                    issue_id: issue_id.to_string(),
                    comment_id: comment.id,
                    body: comment.body,
                    created_at: comment.created_at,
                    updated_at: comment.updated_at,
                }));
            }
            if !issue.comments.page_info.has_next_page {
                return Ok(None);
            }
            comments_cursor = issue.comments.page_info.end_cursor;
            if comments_cursor.is_none() {
                return Err(TrackerError::Invalid(
                    "Linear comments pageInfo omitted endCursor".to_string(),
                ));
            }
        }
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

/// A Linear workflow state (a Kanban column) for a team.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    pub id: String,
    pub name: String,
    /// Linear state category: backlog | unstarted | started | completed | canceled.
    #[serde(rename = "type")]
    pub state_type: String,
    pub position: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowStatesData {
    workflow_states: WorkflowStateConnection,
}

#[derive(Deserialize)]
struct WorkflowStateConnection {
    nodes: Vec<WorkflowState>,
}

#[derive(Deserialize)]
struct IssueWorkflowStatesData {
    issue: Option<LinearIssueWorkflowStatesNode>,
}

#[derive(Deserialize)]
struct LinearIssueWorkflowStatesNode {
    team: LinearIssueWorkflowStatesTeam,
}

#[derive(Deserialize)]
struct LinearIssueWorkflowStatesTeam {
    states: WorkflowStateConnection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueUpdateData {
    issue_update: IssueUpdatePayload,
}

#[derive(Deserialize)]
struct IssueUpdatePayload {
    success: bool,
}

#[derive(Deserialize)]
struct IssuesByStateData {
    issues: LinearIssueConnection,
}

struct PreparedIssuesQuery {
    query: String,
    variables: serde_json::Value,
}

#[derive(Deserialize)]
struct IssueByIdData {
    issue: Option<LinearIssueNode>,
}

#[derive(Deserialize)]
struct IssueCommentsData {
    issue: Option<LinearIssueCommentsNode>,
}

#[derive(Deserialize)]
struct LinearIssueCommentsNode {
    comments: LinearCommentConnection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinearCommentConnection {
    page_info: PageInfo,
    nodes: Vec<LinearComment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinearComment {
    id: String,
    body: String,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct LinearIssueConnection {
    nodes: Vec<LinearIssueNode>,
    #[serde(default, rename = "pageInfo")]
    page_info: Option<PageInfo>,
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
    completed_at: Option<String>,
    canceled_at: Option<String>,
    state: Option<LinearState>,
    project: Option<LinearProject>,
    assignee: Option<LinearAssignee>,
    labels: Option<LinearLabelConnection>,
    inverse_relations: Option<LinearRelationConnection>,
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
        completed_at: node.completed_at,
        canceled_at: node.canceled_at,
        project_id: node.project.as_ref().map(|project| project.id.clone()),
        project_slug_id: node.project.and_then(|project| project.slug_id),
    }
}

const ISSUE_FIELDS: &str = r#"
  id
  identifier
  title
  description
  priority
  branchName
  completedAt
  canceledAt
  state { name }
  project { id slugId }
  assignee { id }
  labels(first: 25) { nodes { name } }
  inverseRelations(first: 25) {
    nodes {
      type
      issue {
        identifier
        state { type }
      }
    }
  }
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
      completedAt
      canceledAt
      state { name }
      project { id slugId }
      assignee { id }
      labels(first: 25) { nodes { name } }
      inverseRelations(first: 25) {
        nodes {
          type
          issue {
            identifier
            state { type }
          }
        }
      }
    }
  }
"#;

const ISSUE_COMMENTS_QUERY: &str = r#"
  query SymphonyIssueWorkpad($id: String!, $commentsCursor: String) {
    issue(id: $id) {
      comments(first: 100, after: $commentsCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          body
          createdAt
          updatedAt
        }
      }
    }
  }
"#;

const WORKFLOW_STATES_QUERY: &str = r#"
  query SymphonyWorkflowStates($teamKey: String!) {
    workflowStates(filter: { team: { key: { eq: $teamKey } } }, first: 100) {
      nodes {
        id
        name
        type
        position
      }
    }
  }
"#;

const ISSUE_WORKFLOW_STATES_QUERY: &str = r#"
  query SymphonyIssueWorkflowStates($id: String!) {
    issue(id: $id) {
      team {
        states(first: 100) {
          nodes {
            id
            name
            type
            position
          }
        }
      }
    }
  }
"#;

const SET_ISSUE_STATE_MUTATION: &str = r#"
  mutation SymphonySetIssueState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
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

    async fn fetch_workpads(
        &self,
        _issue_ids: &[String],
    ) -> Result<Vec<WorkpadComment>, TrackerError> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker_with_teams(team_keys: &[&str]) -> LinearTracker {
        LinearTracker::new(TrackerConfig {
            team_keys: team_keys.iter().map(ToString::to_string).collect(),
            ..Default::default()
        })
    }

    #[test]
    fn team_keys_normalize_and_deduplicate() {
        let tracker = tracker_with_teams(&[" wal- ", "WAL", "sim", "-"]);
        assert_eq!(tracker.team_keys(), ["WAL", "SIM"]);
    }

    #[test]
    fn absent_or_empty_team_keys_yield_no_filter() {
        assert!(tracker_with_teams(&[]).team_keys().is_empty());
        assert!(tracker_with_teams(&["", "-"]).team_keys().is_empty());
    }

    #[test]
    fn project_refs_accept_urls_and_deduplicate() {
        let tracker = LinearTracker::new(TrackerConfig {
            project_ids: vec![
                "https://linear.app/optimism-llc/project/symphony-3171f2ba1c70/overview"
                    .to_string(),
                "symphony-3171f2ba1c70".to_string(),
                "0daba920-df53-4648-93da-114035afb611".to_string(),
            ],
            ..Default::default()
        });

        let refs = tracker.project_refs();
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].slug_id(), Some("3171f2ba1c70"));
        assert_eq!(refs[1].id(), Some("0daba920-df53-4648-93da-114035afb611"));
    }

    #[test]
    fn url_project_refs_match_linear_issue_slug_ids() {
        let tracker = LinearTracker::new(TrackerConfig {
            project_ids: vec![
                "https://linear.app/optimism-llc/project/slopper-755cb427d165/overview".to_string(),
            ],
            ..Default::default()
        });
        let mut issue = issue_for_filter("OP-441", Some("b93dad70-0b6f-4cd0-b536-1be57a27d15d"));
        issue.project_slug_id = Some("755cb427d165".to_string());

        assert_eq!(tracker.filter_issues(vec![issue]).len(), 1);
    }

    fn issue_for_filter(identifier: &str, project_id: Option<&str>) -> Issue {
        Issue {
            id: identifier.to_string(),
            identifier: identifier.to_string(),
            title: "Filter fixture".to_string(),
            description: None,
            priority: 0,
            state: "todo".to_string(),
            branch: None,
            labels: vec![],
            blockers: vec![],
            completed_at: None,
            canceled_at: None,
            project_id: project_id.map(str::to_string),
            project_slug_id: None,
        }
    }

    #[test]
    fn team_and_project_lists_or_within_and_and_across() {
        let tracker = LinearTracker::new(TrackerConfig {
            team_keys: vec!["ENG".to_string(), "SIM".to_string()],
            project_ids: vec!["project-a".to_string(), "project-b".to_string()],
            ..Default::default()
        });
        let issues = vec![
            issue_for_filter("ENG-1", Some("project-a")),
            issue_for_filter("SIM-2", Some("project-b")),
            issue_for_filter("ENG-3", Some("project-c")),
            issue_for_filter("OPS-4", Some("project-a")),
            issue_for_filter("ENG-5", None),
        ];

        let matched = tracker.filter_issues(issues);
        assert_eq!(
            matched
                .iter()
                .map(|issue| issue.identifier.as_str())
                .collect::<Vec<_>>(),
            ["ENG-1", "SIM-2"]
        );
    }

    #[test]
    fn assigned_query_uses_root_issues_with_assignee_filter() {
        let tracker = LinearTracker::new(TrackerConfig {
            team_keys: vec!["ENG".to_string(), "SIM".to_string()],
            project_ids: vec!["project-1".to_string(), "phase-1-00bdaf30dd39".to_string()],
            ..Default::default()
        });
        let states = vec!["Todo".to_string(), "Rework".to_string()];

        let prepared = tracker
            .build_issues_by_state_query_for_assignee(&states, Some("user-1"))
            .expect("query");

        assert!(prepared.query.contains("issues(filter:"));
        assert!(prepared.query.contains("after: $cursor"));
        assert!(prepared
            .query
            .contains("pageInfo { hasNextPage endCursor }"));
        assert!(!prepared.query.contains("assignedIssues"));
        assert!(!prepared.query.contains("viewer {"));
        assert!(prepared.query.contains("$assigneeId: ID!"));
        assert!(prepared
            .query
            .contains("assignee: { id: { eq: $assigneeId } }"));
        assert!(prepared.query.contains("team: { key: { in: $teamKeys } }"));
        assert!(prepared.query.contains(
            "project: { or: [{ id: { in: $projectIds } }, { slugId: { eq: $projectSlugId } }] }"
        ));
        assert_eq!(prepared.variables["s0"], serde_json::json!("Todo"));
        assert_eq!(prepared.variables["s1"], serde_json::json!("Rework"));
        assert_eq!(
            prepared.variables["teamKeys"],
            serde_json::json!(["ENG", "SIM"])
        );
        assert_eq!(
            prepared.variables["projectIds"],
            serde_json::json!(["project-1"])
        );
        assert_eq!(
            prepared.variables["projectSlugId"],
            serde_json::json!("00bdaf30dd39")
        );
        assert_eq!(
            prepared.variables["assigneeId"],
            serde_json::json!("user-1")
        );
    }

    #[test]
    fn issue_queries_bound_nested_connections_without_attachments() {
        let tracker = tracker_with_teams(&[]);
        let states = vec!["Todo".to_string()];
        let prepared = tracker
            .build_issues_by_state_query_for_assignee(&states, None)
            .expect("query");

        for query in [prepared.query.as_str(), ISSUE_BY_ID_QUERY] {
            assert!(query.contains("labels(first: 25)"));
            assert!(query.contains("inverseRelations(first: 25)"));
            assert!(query.contains("completedAt"));
            assert!(query.contains("canceledAt"));
            assert!(!query.contains("attachments"));
        }
    }

    #[test]
    fn workflow_state_query_targets_team_and_orders_by_position() {
        assert!(WORKFLOW_STATES_QUERY
            .contains("workflowStates(filter: { team: { key: { eq: $teamKey } } }"));
        assert!(WORKFLOW_STATES_QUERY.contains("position"));
        assert!(ISSUE_WORKFLOW_STATES_QUERY.contains("issue(id: $id)"));
        assert!(ISSUE_WORKFLOW_STATES_QUERY.contains("team"));
        assert!(ISSUE_WORKFLOW_STATES_QUERY.contains("states(first: 100)"));
        assert!(
            SET_ISSUE_STATE_MUTATION.contains("issueUpdate(id: $id, input: { stateId: $stateId })")
        );
        assert!(SET_ISSUE_STATE_MUTATION.contains("success"));
    }

    #[test]
    fn workflow_states_deserialize_and_sort_by_position() {
        let payload = serde_json::json!({
            "workflowStates": {
                "nodes": [
                    { "id": "s2", "name": "In Progress", "type": "started", "position": 2.0 },
                    { "id": "s1", "name": "Todo", "type": "unstarted", "position": 1.0 }
                ]
            }
        });
        let data: WorkflowStatesData = serde_json::from_value(payload).expect("deserialize");
        let mut states = data.workflow_states.nodes;
        states.sort_by(|a, b| a.position.partial_cmp(&b.position).unwrap());
        assert_eq!(states[0].name, "Todo");
        assert_eq!(states[0].state_type, "unstarted");
        assert_eq!(states[1].id, "s2");
    }

    #[test]
    fn issue_workflow_states_deserialize_for_issue_team_lookup() {
        let payload = serde_json::json!({
            "issue": {
                "team": {
                    "states": {
                        "nodes": [
                            { "id": "s1", "name": "Todo", "type": "unstarted", "position": 1.0 },
                            { "id": "s2", "name": "In Review", "type": "started", "position": 2.0 }
                        ]
                    }
                }
            }
        });
        let data: IssueWorkflowStatesData = serde_json::from_value(payload).expect("deserialize");
        let state = data
            .issue
            .unwrap()
            .team
            .states
            .nodes
            .into_iter()
            .find(|state| state.name.eq_ignore_ascii_case("in review"))
            .unwrap();

        assert_eq!(state.id, "s2");
    }

    #[test]
    fn board_issues_query_filters_team_and_project_without_states() {
        let tracker = LinearTracker::new(TrackerConfig {
            team_keys: vec!["ENG".to_string(), "SIM".to_string()],
            project_ids: vec!["project-9".to_string()],
            ..Default::default()
        });
        let prepared = tracker.build_board_issues_query();
        assert!(prepared.query.contains("SymphonyBoardIssues"));
        assert!(prepared.query.contains("team: { key: { in: $teamKeys } }"));
        assert!(prepared
            .query
            .contains("project: { id: { in: $projectIds } }"));
        assert!(!prepared.query.contains("state:"));
        assert_eq!(
            prepared.variables["teamKeys"],
            serde_json::json!(["ENG", "SIM"])
        );
        assert_eq!(
            prepared.variables["projectIds"],
            serde_json::json!(["project-9"])
        );
        assert!(prepared.query.contains("after: $cursor"));
        assert!(prepared.query.contains("pageInfo"));
        assert!(prepared.query.contains("$cursor: String"));
    }
}
