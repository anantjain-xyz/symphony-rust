use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

/// A stable file identity protects the shared app-data directory for the entire
/// runtime. Never unlink the file: another process could lock its replacement.
pub(crate) struct InstanceLease {
    _file: File,
}

impl InstanceLease {
    pub(crate) fn acquire(app_data_dir: &Path) -> io::Result<Option<Self>> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(app_data_dir.join("application.lock"))?;
        match file.try_lock() {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(error)) => Err(error),
        }
    }
}

pub(crate) fn activate_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        activate_window(&window);
    }
}

trait ActivationWindow {
    fn unminimize(&self) -> tauri::Result<()>;
    fn show(&self) -> tauri::Result<()>;
    fn focus(&self) -> tauri::Result<()>;
}

impl<R: Runtime> ActivationWindow for WebviewWindow<R> {
    fn unminimize(&self) -> tauri::Result<()> {
        self.unminimize()
    }

    fn show(&self) -> tauri::Result<()> {
        self.show()
    }

    fn focus(&self) -> tauri::Result<()> {
        self.set_focus()
    }
}

fn activate_window(window: &impl ActivationWindow) {
    // A failed unminimize must not suppress the remaining activation attempts.
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.focus();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, process::Command};

    const CHILD_DIRECTORY: &str = "SYMPHONY_INSTANCE_LEASE_TEST_DIRECTORY";
    const CHILD_EXPECTATION: &str = "SYMPHONY_INSTANCE_LEASE_TEST_EXPECTATION";

    // This entry point runs only the lease against a temporary directory. It
    // never constructs Symphony, opens a database, or accesses the OS keychain.
    #[test]
    fn lease_child() {
        let Some(directory) = std::env::var_os(CHILD_DIRECTORY) else {
            return;
        };
        let expected = std::env::var(CHILD_EXPECTATION).unwrap();
        let lease = InstanceLease::acquire(Path::new(&directory)).unwrap();
        assert_eq!(lease.is_some(), expected == "owner");
        if lease.is_some() {
            std::fs::write(Path::new(&directory).join("runtime-started"), b"admitted").unwrap();
            // Abrupt process exit must release the OS lease without destructors.
            std::process::exit(0);
        }
    }

    fn run_child(directory: &Path, expectation: &str) {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "application_instance::tests::lease_child",
                "--nocapture",
            ])
            .env(CHILD_DIRECTORY, directory)
            .env(CHILD_EXPECTATION, expectation)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn another_process_cannot_start_runtime_until_the_owner_exits() {
        let directory = tempfile::tempdir().unwrap();
        let owner = InstanceLease::acquire(directory.path()).unwrap().unwrap();
        run_child(directory.path(), "blocked");
        assert!(!directory.path().join("runtime-started").exists());
        assert!(InstanceLease::acquire(directory.path()).unwrap().is_none());
        drop(owner);

        run_child(directory.path(), "owner");
        assert!(directory.path().join("runtime-started").exists());
        // The child exited without dropping its lease; a later launch is still
        // admitted. The stable lock file itself is deliberately retained.
        assert!(directory.path().join("application.lock").is_file());
        assert!(InstanceLease::acquire(directory.path()).unwrap().is_some());
    }

    #[test]
    fn lease_io_errors_never_admit_a_runtime() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("application.lock")).unwrap();
        assert!(InstanceLease::acquire(directory.path()).is_err());
    }

    #[derive(Default)]
    struct Window {
        actions: RefCell<Vec<&'static str>>,
        fail_unminimize: bool,
    }

    impl ActivationWindow for Window {
        fn unminimize(&self) -> tauri::Result<()> {
            self.actions.borrow_mut().push("unminimize");
            if self.fail_unminimize {
                return Err(io::Error::other("test window cannot unminimize").into());
            }
            Ok(())
        }

        fn show(&self) -> tauri::Result<()> {
            self.actions.borrow_mut().push("show");
            Ok(())
        }

        fn focus(&self) -> tauri::Result<()> {
            self.actions.borrow_mut().push("focus");
            Ok(())
        }
    }

    #[test]
    fn repeated_launch_restores_shows_and_focuses_the_existing_window() {
        for fail_unminimize in [false, true] {
            let window = Window {
                fail_unminimize,
                ..Window::default()
            };
            activate_window(&window);
            assert_eq!(*window.actions.borrow(), ["unminimize", "show", "focus"]);
        }
    }

    #[test]
    fn startup_enforces_instance_admission_before_shared_runtime_setup() {
        let source = include_str!("lib.rs");
        let run = source.split_once("pub fn run() {").unwrap().1;
        let plugin = run.find(".plugin(").unwrap();
        assert!(run[plugin..].starts_with(".plugin(tauri_plugin_single_instance::init("));
        let setup = run.find(".setup(move |app| {").unwrap();
        assert!(plugin < setup);
        assert!(run[plugin..setup].contains("application_instance::activate_main_window(app)"));

        let lease = run
            .find("application_instance::InstanceLease::acquire(&app_dir)?")
            .unwrap();
        let retained = run.find("app.manage(lease)").unwrap();
        let exit = run.find("None => std::process::exit(0)").unwrap();
        assert!(setup < lease && lease < retained && retained < exit);
        for first_effect in [
            "keyring::use_native_store",
            "open_sqlite(&db_path)",
            "WorkerManager::new",
            "settings_store::SettingsStore::new",
        ] {
            assert!(
                exit < run.find(first_effect).unwrap(),
                "{first_effect} precedes admission"
            );
        }
    }
}
