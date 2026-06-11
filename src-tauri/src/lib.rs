use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::BTreeMap, path::PathBuf};
use symphony_core::{parse_workflow_source, AgentBackend};
use symphony_storage::{
    open_sqlite, AgentEventRow, EventBus, IssueRow, Overview, Repository, RunWithIssueRow,
    StorageEvent,
};
use symphony_tracker::{LinearTracker, TrackerClient};
use symphony_worker::{
    check_skills, resolve_workspace_root_dir, SkillFile, SkillsInstallConfig, SkillsInstallStatus,
    SkillsInstaller, SkillsStatus, WorkerManager, WorkerStartConfig, WorkerStatus,
};
use tauri::{Emitter, Manager, State};

mod path_env;

const KEYRING_SERVICE: &str = "symphony";
const KEYRING_LINEAR_USER: &str = "linear_api_key";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppSettings {
    pub workflow_source: String,
    pub repo_url: String,
    pub tracker_workspace: Option<String>,
    pub tracker_prefix: Option<String>,
    pub tracker_project_id: Option<String>,
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub install_cmd: Option<String>,
    pub agent_backend: AgentBackend,
    pub linear_api_key_set: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            workflow_source: default_workflow_source(),
            repo_url: String::new(),
            tracker_workspace: None,
            tracker_prefix: None,
            tracker_project_id: None,
            workspace_root: None,
            install_cmd: None,
            agent_backend: AgentBackend::Codex,
            linear_api_key_set: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SaveSettingsRequest {
    pub settings: AppSettings,
    pub linear_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ValidationResult {
    pub workflow_ok: bool,
    pub workflow_error: Option<String>,
    pub codex_found: bool,
    pub claude_found: bool,
    pub app_data_dir: String,
    pub database_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TrackerTestResult {
    pub ok: bool,
    pub message: String,
    pub active_issue_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RunDetail {
    pub run: RunWithIssueRow,
    pub events: Vec<AgentEventRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct IssueDetail {
    pub issue: IssueRow,
}

#[derive(Clone)]
struct AppState {
    repo: Repository,
    worker: WorkerManager,
    skills_installer: SkillsInstaller,
    app_data_dir: PathBuf,
    settings_path: PathBuf,
    database_path: PathBuf,
}

/// The agent skills shipped with the app, installed into target repos under
/// `.agents/skills/<name>/SKILL.md`. Source of truth: symphony-ts.
fn bundled_skills() -> Vec<SkillFile> {
    macro_rules! skill {
        ($name:literal) => {
            SkillFile {
                name: $name.to_string(),
                content: include_str!(concat!("../assets/skills/", $name, "/SKILL.md")).to_string(),
            }
        };
    }
    vec![
        skill!("commit"),
        skill!("land"),
        skill!("pr-feedback"),
        skill!("pull"),
        skill!("push"),
        skill!("screenshot"),
        skill!("workpad"),
    ]
}

#[tauri::command]
async fn load_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    load_settings_from_disk(&state).await
}

#[tauri::command]
async fn save_settings(
    state: State<'_, AppState>,
    request: SaveSettingsRequest,
) -> Result<AppSettings, String> {
    if let Some(key) = request.linear_api_key.as_ref() {
        if !key.trim().is_empty() {
            keyring_entry()
                .map_err(|err| err.to_string())?
                .set_password(key)
                .map_err(|err| err.to_string())?;
        }
    }
    let mut settings = request.settings;
    settings.linear_api_key_set = linear_api_key().is_some();
    let json = serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?;
    tokio::fs::write(&state.settings_path, json)
        .await
        .map_err(|err| err.to_string())?;
    Ok(settings)
}

#[tauri::command]
async fn validate_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<ValidationResult, String> {
    let env = build_env(&state, &settings);
    let workflow_result = parse_workflow_source(&settings.workflow_source, &env);
    Ok(ValidationResult {
        workflow_ok: workflow_result.is_ok(),
        workflow_error: workflow_result.err().map(|err| err.to_string()),
        codex_found: which::which("codex").is_ok(),
        claude_found: which::which("claude").is_ok(),
        app_data_dir: state.app_data_dir.display().to_string(),
        database_path: state.database_path.display().to_string(),
    })
}

#[tauri::command]
async fn test_tracker_connection(
    state: State<'_, AppState>,
    request: SaveSettingsRequest,
) -> Result<TrackerTestResult, String> {
    let mut env = build_env(&state, &request.settings);
    if let Some(key) = request
        .linear_api_key
        .as_ref()
        .filter(|key| !key.trim().is_empty())
    {
        env.insert("LINEAR_API_KEY".to_string(), key.clone());
    }

    let workflow = match parse_workflow_source(&request.settings.workflow_source, &env) {
        Ok(workflow) => workflow,
        Err(err) => {
            return Ok(TrackerTestResult {
                ok: false,
                message: format!("Workflow error: {err}"),
                active_issue_count: None,
            })
        }
    };
    if workflow.front_matter.tracker.api_key.trim().is_empty() {
        return Ok(TrackerTestResult {
            ok: false,
            message: "No Linear API key configured. Add one above, then test again.".to_string(),
            active_issue_count: None,
        });
    }

    let tracker = LinearTracker::new(workflow.front_matter.tracker.clone());
    if let Err(err) = tracker.preflight().await {
        return Ok(TrackerTestResult {
            ok: false,
            message: err.to_string(),
            active_issue_count: None,
        });
    }
    match tracker.fetch_active().await {
        Ok(issues) => Ok(TrackerTestResult {
            ok: true,
            message: match issues.len() {
                0 => "Connected. No issues currently match your filters.".to_string(),
                1 => "Connected. 1 issue matches your filters.".to_string(),
                n => format!("Connected. {n} issues match your filters."),
            },
            active_issue_count: Some(issues.len() as u32),
        }),
        Err(err) => Ok(TrackerTestResult {
            ok: false,
            message: err.to_string(),
            active_issue_count: None,
        }),
    }
}

#[tauri::command]
async fn remove_linear_api_key(state: State<'_, AppState>) -> Result<AppSettings, String> {
    match keyring_entry() {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => {}
            Err(err) => return Err(err.to_string()),
        },
        Err(err) => return Err(err.to_string()),
    }
    load_settings_from_disk(&state).await
}

#[tauri::command]
fn get_default_workflow() -> String {
    default_workflow_source()
}

#[tauri::command]
async fn get_overview(state: State<'_, AppState>) -> Result<Overview, String> {
    state.repo.overview().await.map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_runs(state: State<'_, AppState>) -> Result<Vec<RunWithIssueRow>, String> {
    state
        .repo
        .list_runs(200)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_run_detail(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<RunDetail>, String> {
    state
        .repo
        .get_run_detail(&id)
        .await
        .map(|detail| detail.map(|(run, events)| RunDetail { run, events }))
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_issues(state: State<'_, AppState>) -> Result<Vec<IssueRow>, String> {
    state
        .repo
        .list_issues(200)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_issue_detail(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<IssueDetail>, String> {
    state
        .repo
        .get_issue(&id)
        .await
        .map(|issue| issue.map(|issue| IssueDetail { issue }))
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_worker_status(state: State<'_, AppState>) -> Result<WorkerStatus, String> {
    Ok(state.worker.status().await)
}

#[tauri::command]
async fn start_worker(state: State<'_, AppState>) -> Result<WorkerStatus, String> {
    let settings = load_settings_from_disk(&state).await?;
    let env = build_env(&state, &settings);
    state
        .worker
        .start(WorkerStartConfig {
            workflow_source: settings.workflow_source,
            env,
            app_data_dir: state.app_data_dir.clone(),
        })
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn stop_worker(state: State<'_, AppState>) -> Result<WorkerStatus, String> {
    Ok(state.worker.stop().await)
}

#[tauri::command]
async fn get_skills_status(state: State<'_, AppState>) -> Result<SkillsStatus, String> {
    let settings = load_settings_from_disk(&state).await?;
    let names: Vec<String> = bundled_skills()
        .into_iter()
        .map(|skill| skill.name)
        .collect();
    Ok(check_skills(&settings.repo_url, &names).await)
}

#[tauri::command]
async fn get_skills_install_status(
    state: State<'_, AppState>,
) -> Result<SkillsInstallStatus, String> {
    Ok(state.skills_installer.status().await)
}

#[tauri::command]
async fn install_skills(state: State<'_, AppState>) -> Result<SkillsInstallStatus, String> {
    let settings = load_settings_from_disk(&state).await?;
    if settings.repo_url.trim().is_empty() {
        return Err("Add a repository URL under Settings → Repository first.".to_string());
    }
    let env = build_env(&state, &settings);
    let workflow =
        parse_workflow_source(&settings.workflow_source, &env).map_err(|err| err.to_string())?;
    let workspace_root = resolve_workspace_root_dir(
        &workflow.front_matter.workspace.root,
        &env,
        &state.app_data_dir,
    );
    state
        .skills_installer
        .start(SkillsInstallConfig {
            repo_url: settings.repo_url.clone(),
            workspace_root,
            workflow,
            skills: bundled_skills(),
        })
        .await
        .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // GUI launches inherit launchd's minimal PATH, which breaks hooks and
    // agent processes that need user-installed tools. Overlay the login-shell
    // PATH before Tauri spawns threads that read the environment.
    let path_fix = path_env::fix();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let app_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_dir)?;
            let _ = keyring::use_native_store(false);
            init_tracing(&app_dir);
            match &path_fix {
                Ok(path) => tracing::info!(target: "symphony", %path, "login-shell PATH overlaid"),
                Err(error) => tracing::warn!(
                    target: "symphony",
                    %error,
                    "login-shell PATH resolution failed; keeping inherited PATH"
                ),
            }
            let db_path = app_dir.join("symphony.sqlite");
            let (repo, bus) = tauri::async_runtime::block_on(async {
                let bus = EventBus::default();
                let pool = open_sqlite(&db_path).await?;
                let repo = Repository::new(pool, bus.clone());
                Ok::<_, symphony_storage::StorageError>((repo, bus))
            })?;
            let worker = WorkerManager::new(repo.clone());
            let state = AppState {
                repo,
                worker,
                skills_installer: SkillsInstaller::new(),
                app_data_dir: app_dir.clone(),
                settings_path: app_dir.join("settings.json"),
                database_path: db_path,
            };
            export_bindings();
            forward_events(handle, bus);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            validate_settings,
            test_tracker_connection,
            remove_linear_api_key,
            get_default_workflow,
            get_overview,
            list_runs,
            get_run_detail,
            list_issues,
            get_issue_detail,
            get_worker_status,
            start_worker,
            stop_worker,
            get_skills_status,
            get_skills_install_status,
            install_skills
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn forward_events(handle: tauri::AppHandle, bus: EventBus) {
    tauri::async_runtime::spawn(async move {
        let mut rx = bus.subscribe();
        while let Ok(event) = rx.recv().await {
            match &event {
                StorageEvent::DbChanged { .. } => {
                    let _ = handle.emit("db_changed", &event);
                }
                StorageEvent::AgentEvent { .. } => {
                    let _ = handle.emit("agent_event", &event);
                }
                StorageEvent::RateLimitChanged { .. } => {
                    let _ = handle.emit("rate_limit_changed", &event);
                }
            }
        }
    });
}

async fn load_settings_from_disk(state: &AppState) -> Result<AppSettings, String> {
    let mut settings = match tokio::fs::read_to_string(&state.settings_path).await {
        Ok(raw) => serde_json::from_str::<AppSettings>(&raw).map_err(|err| err.to_string())?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => AppSettings::default(),
        Err(err) => return Err(err.to_string()),
    };
    settings.linear_api_key_set = linear_api_key().is_some();
    Ok(settings)
}

fn build_env(state: &AppState, settings: &AppSettings) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    if let Some(key) = linear_api_key() {
        env.insert("LINEAR_API_KEY".to_string(), key);
    }
    env.insert("REPO_URL".to_string(), settings.repo_url.clone());
    env.insert(
        "SYMPHONY_LINEAR_WORKSPACE".to_string(),
        settings.tracker_workspace.clone().unwrap_or_default(),
    );
    env.insert(
        "SYMPHONY_TRACKER_PREFIX".to_string(),
        settings.tracker_prefix.clone().unwrap_or_default(),
    );
    env.insert(
        "SYMPHONY_TRACKER_PROJECT_ID".to_string(),
        settings.tracker_project_id.clone().unwrap_or_default(),
    );
    env.insert(
        "SYMPHONY_AGENT_BACKEND".to_string(),
        match settings.agent_backend {
            AgentBackend::Codex => "codex".to_string(),
            AgentBackend::Claude => "claude".to_string(),
        },
    );
    env.insert(
        "TMPDIR".to_string(),
        settings
            .workspace_root
            .clone()
            .unwrap_or_else(|| state.app_data_dir.join("workspaces").display().to_string()),
    );
    if let Some(cmd) = settings
        .install_cmd
        .as_ref()
        .filter(|cmd| !cmd.trim().is_empty())
    {
        env.insert("SYMPHONY_INSTALL_CMD".to_string(), cmd.clone());
    }
    env
}

fn keyring_entry() -> keyring_core::Result<keyring_core::Entry> {
    keyring_core::Entry::new(KEYRING_SERVICE, KEYRING_LINEAR_USER)
}

fn linear_api_key() -> Option<String> {
    keyring_entry().ok()?.get_password().ok()
}

fn init_tracing(app_dir: &std::path::Path) {
    let log_dir = app_dir.join("logs");
    let file_appender = tracing_appender::rolling::daily(log_dir, "symphony.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let _guard = Box::leak(Box::new(guard));
    let subscriber = tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "symphony=info,symphony_worker=info".into()),
        )
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
}

fn export_bindings() {
    #[cfg(debug_assertions)]
    {
        let conf = specta::ts::ExportConfiguration::default()
            .bigint(specta::ts::BigIntExportBehavior::Number);
        let exports = [
            specta::ts::export::<AppSettings>(&conf),
            specta::ts::export::<SaveSettingsRequest>(&conf),
            specta::ts::export::<ValidationResult>(&conf),
            specta::ts::export::<TrackerTestResult>(&conf),
            specta::ts::export::<Overview>(&conf),
            specta::ts::export::<RunWithIssueRow>(&conf),
            specta::ts::export::<RunDetail>(&conf),
            specta::ts::export::<IssueRow>(&conf),
            specta::ts::export::<IssueDetail>(&conf),
            specta::ts::export::<AgentEventRow>(&conf),
            specta::ts::export::<WorkerStatus>(&conf),
            specta::ts::export::<StorageEvent>(&conf),
            specta::ts::export::<SkillsStatus>(&conf),
            specta::ts::export::<SkillsInstallStatus>(&conf),
        ]
        .into_iter()
        .filter_map(Result::ok)
        .collect::<Vec<_>>()
        .join("\n\n");
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("src/bindings.ts");
        let _ = std::fs::write(
            path,
            format!("// Generated by src-tauri at dev startup.\n{exports}\n"),
        );
    }
}

fn default_workflow_source() -> String {
    include_str!("../assets/default-workflow.md").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_env() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("LINEAR_API_KEY".to_string(), "lin_api_test".to_string()),
            ("TMPDIR".to_string(), "/tmp/workspaces".to_string()),
        ])
    }

    #[test]
    fn default_workflow_parses_with_minimal_env() {
        let parsed = parse_workflow_source(&default_workflow_source(), &settings_env())
            .expect("default workflow must parse");
        assert_eq!(parsed.front_matter.tracker.kind, "linear");
        assert_eq!(parsed.front_matter.tracker.api_key, "lin_api_test");
        // Unset optional Settings vars interpolate to empty and are dropped.
        assert_eq!(parsed.front_matter.tracker.identifier_prefix, None);
        // Backend falls back to codex when Settings has not populated it.
        assert_eq!(
            parsed.front_matter.agent.backend,
            symphony_core::AgentBackend::Codex
        );
        assert!(parsed.front_matter.codex.network_access);
        assert!(!parsed.front_matter.claude.allowed_tools.is_empty());
        // Hooks keep shell-style defaults for bash to expand at run time.
        let after_create = parsed.front_matter.hooks.after_create.expect("hook");
        assert!(after_create.contains("${ISSUE_BRANCH:-symphony/${ISSUE_IDENTIFIER}}"));
        assert!(after_create.contains("${SYMPHONY_INSTALL_CMD:-npm ci}"));
    }

    #[test]
    fn bundled_skills_match_their_frontmatter_names() {
        let skills = bundled_skills();
        assert_eq!(skills.len(), 7);
        for skill in skills {
            let name_line = format!("name: {}", skill.name);
            assert!(
                skill
                    .content
                    .lines()
                    .take(5)
                    .any(|line| line.trim() == name_line),
                "skill {} frontmatter does not declare its directory name",
                skill.name
            );
            assert!(skill.content.starts_with("---\n"));
        }
    }

    #[test]
    fn default_workflow_references_every_bundled_skill() {
        let workflow = default_workflow_source();
        for skill in bundled_skills() {
            assert!(
                workflow.contains(&format!("`{}`", skill.name)),
                "default workflow never mentions the bundled skill {}",
                skill.name
            );
        }
    }

    #[test]
    fn default_workflow_uses_supported_prompt_placeholders() {
        let parsed = parse_workflow_source(&default_workflow_source(), &settings_env()).unwrap();
        let unresolved = ["{{identifier}}", "{{title}}", "{{#", "{{/", "{{state}}"];
        for token in unresolved {
            assert!(
                !parsed.prompt_template.contains(token),
                "prompt template contains unsupported placeholder: {token}"
            );
        }
        for token in [
            "{{issue.identifier}}",
            "{{issue.title}}",
            "{{issue.state}}",
            "{{issue.labels}}",
            "{{issue.description}}",
        ] {
            assert!(
                parsed.prompt_template.contains(token),
                "prompt template is missing placeholder: {token}"
            );
        }
    }
}
