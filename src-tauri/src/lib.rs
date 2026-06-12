use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::BTreeMap, path::PathBuf};
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
mod settings;

pub use settings::AppSettings;
use settings::{default_prompt_template, parse_settings, workflow_from_settings};

const KEYRING_SERVICE: &str = "symphony";
const KEYRING_LINEAR_USER: &str = "linear_api_key";

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
    pub codex_command: String,
    pub claude_command: String,
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
    let workflow_error = validate_workflow_settings(&settings);
    let codex_command = effective_command(settings.codex_command.as_deref(), "codex");
    let claude_command = effective_command(settings.claude_command.as_deref(), "claude");
    Ok(ValidationResult {
        workflow_ok: workflow_error.is_none(),
        workflow_error,
        codex_found: command_found(&codex_command),
        claude_found: command_found(&claude_command),
        codex_command,
        claude_command,
        app_data_dir: state.app_data_dir.display().to_string(),
        database_path: state.database_path.display().to_string(),
    })
}

fn validate_workflow_settings(settings: &AppSettings) -> Option<String> {
    if settings
        .active_states
        .iter()
        .all(|state| state.trim().is_empty())
    {
        return Some(
            "Active states is empty — the worker would never pick up an issue. Add at least one Linear state under Settings → Linear.".to_string(),
        );
    }
    if settings.prompt_template.trim().is_empty() {
        return Some("The prompt template is empty.".to_string());
    }
    let unknown = unknown_placeholders(&settings.prompt_template);
    if !unknown.is_empty() {
        return Some(format!(
            "Unknown prompt placeholder{}: {}. Supported: {}.",
            if unknown.len() == 1 { "" } else { "s" },
            unknown.join(", "),
            symphony_core::PROMPT_VARIABLES.join(", ")
        ));
    }
    None
}

/// Scan `{{...}}` placeholders in the prompt and report any that
/// `render_prompt` would leave unresolved.
fn unknown_placeholders(prompt: &str) -> Vec<String> {
    let mut unknown = Vec::new();
    let mut rest = prompt;
    while let Some(start) = rest.find("{{") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("}}") else { break };
        let name = rest[..end].trim();
        // Only flag plausible variable names; literal braces in prose (e.g.
        // JSON examples) are not placeholders.
        let looks_like_var = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_');
        if looks_like_var
            && !symphony_core::PROMPT_VARIABLES.contains(&name)
            && !unknown.iter().any(|seen| seen == name)
        {
            unknown.push(name.to_string());
        }
        rest = &rest[end + 2..];
    }
    unknown
}

fn effective_command(override_cmd: Option<&str>, default: &str) -> String {
    match override_cmd.map(str::trim).filter(|cmd| !cmd.is_empty()) {
        Some(cmd) => cmd.to_string(),
        None => default.to_string(),
    }
}

// Launch commands may be wrappers with arguments (`mycode --agent codex`);
// only the first token names the executable to look up.
fn command_found(command: &str) -> bool {
    command
        .split_whitespace()
        .next()
        .is_some_and(|bin| which::which(bin).is_ok())
}

#[tauri::command]
async fn test_tracker_connection(request: SaveSettingsRequest) -> Result<TrackerTestResult, String> {
    // Prefer the unsaved form value so users can test a just-typed key.
    let api_key = request
        .linear_api_key
        .filter(|key| !key.trim().is_empty())
        .or_else(linear_api_key);
    let Some(api_key) = api_key else {
        return Ok(TrackerTestResult {
            ok: false,
            message: "No Linear API key configured. Add one above, then test again.".to_string(),
            active_issue_count: None,
        });
    };

    let workflow = workflow_from_settings(&request.settings, Some(&api_key));
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
fn get_default_prompt() -> String {
    default_prompt_template()
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
    let api_key = linear_api_key();
    let workflow = workflow_from_settings(&settings, api_key.as_deref());
    let env = build_env(&settings);
    state
        .worker
        .start(WorkerStartConfig {
            workflow,
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

// Both skills commands take the caller's settings (like validate_settings)
// rather than reloading from disk, so unsaved form edits — a just-typed repo
// URL in particular — are what gets checked and installed against.
#[tauri::command]
async fn get_skills_status(settings: AppSettings) -> Result<SkillsStatus, String> {
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
async fn install_skills(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<SkillsInstallStatus, String> {
    if settings.repo_url.trim().is_empty() {
        return Err("Add a repository URL under Settings → Repository first.".to_string());
    }
    let api_key = linear_api_key();
    let workflow = workflow_from_settings(&settings, api_key.as_deref());
    let workspace_root =
        resolve_workspace_root_dir(&workflow.front_matter.workspace.root, &state.app_data_dir);
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
            get_default_prompt,
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
        Ok(raw) => {
            let (settings, migrated) = parse_settings(&raw)?;
            if migrated {
                // The legacy workflow's customized front matter is discarded;
                // keep the original file around in case the user needs it.
                let backup = state.settings_path.with_extension("json.bak");
                tokio::fs::write(&backup, &raw)
                    .await
                    .map_err(|err| err.to_string())?;
                let json = serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?;
                tokio::fs::write(&state.settings_path, json)
                    .await
                    .map_err(|err| err.to_string())?;
                tracing::info!(
                    target: "symphony",
                    backup = %backup.display(),
                    "migrated legacy workflow settings to structured settings"
                );
            }
            settings
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => AppSettings::default(),
        Err(err) => return Err(err.to_string()),
    };
    settings.linear_api_key_set = linear_api_key().is_some();
    Ok(settings)
}

/// Environment for hooks and agents (the structured settings feed the
/// workflow config directly; this only carries what shell scripts and agent
/// processes need at execution time).
fn build_env(settings: &AppSettings) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    if let Some(key) = linear_api_key() {
        env.insert("LINEAR_API_KEY".to_string(), key);
    }
    env.insert("REPO_URL".to_string(), settings.repo_url.clone());
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
            specta::ts::export::<symphony_core::AgentBackend>(&conf),
            specta::ts::export::<symphony_core::ApprovalPolicy>(&conf),
            specta::ts::export::<symphony_core::ThreadSandbox>(&conf),
            specta::ts::export::<symphony_core::TurnSandboxPolicy>(&conf),
            specta::ts::export::<symphony_core::ClaudePermissionMode>(&conf),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_build_a_usable_workflow() {
        let settings = AppSettings::default();
        let workflow = workflow_from_settings(&settings, Some("lin_api_test"));
        assert_eq!(workflow.front_matter.tracker.api_key, "lin_api_test");
        assert_eq!(workflow.front_matter.tracker.identifier_prefix, None);
        assert_eq!(
            workflow.front_matter.agent.backend,
            symphony_core::AgentBackend::Codex
        );
        assert!(workflow.front_matter.codex.network_access);
        assert!(!workflow.front_matter.claude.allowed_tools.is_empty());
        // Launch commands fall back to the bare CLI names when Settings
        // leaves them blank.
        assert_eq!(workflow.front_matter.codex.command, "codex");
        assert_eq!(workflow.front_matter.claude.command, "claude");
        // Hooks keep shell-style defaults for bash to expand at run time.
        let after_create = workflow.front_matter.hooks.after_create.expect("hook");
        assert!(after_create.contains("${ISSUE_BRANCH:-symphony/${ISSUE_IDENTIFIER}}"));
        assert!(after_create.contains("${SYMPHONY_INSTALL_CMD:-npm ci}"));
        assert!(validate_workflow_settings(&settings).is_none());
    }

    #[test]
    fn validation_flags_empty_states_and_unknown_placeholders() {
        let no_states = AppSettings {
            active_states: Vec::new(),
            ..AppSettings::default()
        };
        assert!(validate_workflow_settings(&no_states)
            .expect("empty active states must fail validation")
            .contains("Active states"));

        let bad_prompt = AppSettings {
            prompt_template: "Fix {{issue.foo}} and {{issue.title}}".to_string(),
            ..AppSettings::default()
        };
        let error = validate_workflow_settings(&bad_prompt).expect("unknown placeholder");
        assert!(error.contains("issue.foo"), "unexpected error: {error}");
        // Known placeholders are not flagged.
        assert_eq!(
            unknown_placeholders(&bad_prompt.prompt_template),
            vec!["issue.foo"]
        );
    }

    #[test]
    fn placeholder_scan_ignores_non_variable_braces() {
        assert!(unknown_placeholders("code sample: {{\"key\": 1}} and {{ issue.title }}").is_empty());
        assert_eq!(unknown_placeholders("{{issue.nope}}"), vec!["issue.nope"]);
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
    fn default_prompt_references_every_bundled_skill() {
        let prompt = default_prompt_template();
        for skill in bundled_skills() {
            assert!(
                prompt.contains(&format!("`{}`", skill.name)),
                "default prompt never mentions the bundled skill {}",
                skill.name
            );
        }
    }

    #[test]
    fn command_found_checks_first_token_only() {
        assert!(command_found("sh -lc"));
        assert!(!command_found("symphony-test-missing-binary --agent codex"));
        assert!(!command_found(""));
    }

    #[test]
    fn effective_command_falls_back_on_blank_overrides() {
        assert_eq!(effective_command(None, "codex"), "codex");
        assert_eq!(effective_command(Some("  "), "codex"), "codex");
        assert_eq!(
            effective_command(Some("mycode --agent codex"), "codex"),
            "mycode --agent codex"
        );
    }

    #[test]
    fn default_prompt_uses_supported_placeholders() {
        let prompt = default_prompt_template();
        assert!(
            unknown_placeholders(&prompt).is_empty(),
            "default prompt contains unsupported placeholders: {:?}",
            unknown_placeholders(&prompt)
        );
        for token in [
            "{{issue.identifier}}",
            "{{issue.title}}",
            "{{issue.state}}",
            "{{issue.labels}}",
            "{{issue.description}}",
        ] {
            assert!(
                prompt.contains(token),
                "prompt template is missing placeholder: {token}"
            );
        }
    }
}
