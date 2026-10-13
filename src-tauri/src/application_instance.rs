use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

/// A stable file identity protects the shared app-data directory for the entire
/// runtime. Never unlink the file: another process could lock its replacement.
pub(crate) struct InstanceLease {
    _file: File,
}

impl InstanceLease {
    pub(crate) fn acquire(app_data_dir: &Path) -> io::Result<Option<Self>> {
        // Tauri spawns its replacement before exiting. Keep exclusivity while
        // allowing the old process time to release the lease at actual exit.
        Self::acquire_with_timeout(app_data_dir, Duration::from_secs(5))
    }

    fn acquire_with_timeout(app_data_dir: &Path, timeout: Duration) -> io::Result<Option<Self>> {
        Self::acquire_waiting(app_data_dir, timeout, std::thread::sleep)
    }

    fn acquire_waiting(
        app_data_dir: &Path,
        timeout: Duration,
        mut wait: impl FnMut(Duration),
    ) -> io::Result<Option<Self>> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(app_data_dir.join("application.lock"))?;
        let started = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Some(Self { _file: file })),
                Err(std::fs::TryLockError::WouldBlock) => {
                    let remaining = timeout.saturating_sub(started.elapsed());
                    if remaining.is_zero() {
                        return Ok(None);
                    }
                    wait(Duration::from_millis(25).min(remaining));
                }
                Err(std::fs::TryLockError::Error(error)) => return Err(error),
            }
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
    use std::{
        cell::RefCell,
        io::{Read, Write},
        process::{Child, Command, Stdio},
    };

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
        let directory = Path::new(&directory);
        let lease = if expected == "replacement" {
            let mut first_wait = true;
            InstanceLease::acquire_waiting(directory, Duration::from_secs(5), |duration| {
                if first_wait {
                    first_wait = false;
                    std::fs::write(directory.join("replacement-contended"), b"waiting").unwrap();
                    std::io::stdin().read_exact(&mut [0]).unwrap();
                }
                std::thread::sleep(duration);
            })
            .unwrap()
        } else {
            InstanceLease::acquire_with_timeout(directory, Duration::ZERO).unwrap()
        };
        assert_eq!(lease.is_some(), expected != "blocked");
        if expected == "delayed-owner" {
            std::fs::write(directory.join("owner-ready"), b"locked").unwrap();
            std::io::stdin().read_exact(&mut [0]).unwrap();
            std::process::exit(0);
        }
        if lease.is_some() {
            std::fs::write(directory.join("runtime-started"), b"admitted").unwrap();
            // Abrupt process exit must release the OS lease without destructors.
            std::process::exit(0);
        }
    }

    fn child_command(directory: &Path, expectation: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "application_instance::tests::lease_child",
            "--nocapture",
        ]);
        command.env(CHILD_DIRECTORY, directory);
        command.env(CHILD_EXPECTATION, expectation);
        command
    }

    fn run_child(directory: &Path, expectation: &str) {
        let output = child_command(directory, expectation).output().unwrap();
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
        assert!(
            InstanceLease::acquire_with_timeout(directory.path(), Duration::ZERO)
                .unwrap()
                .is_none()
        );
        drop(owner);

        run_child(directory.path(), "owner");
        assert!(directory.path().join("runtime-started").exists());
        // The child exited without dropping its lease; a later launch is still
        // admitted. The stable lock file itself is deliberately retained.
        assert!(directory.path().join("application.lock").is_file());
        assert!(InstanceLease::acquire(directory.path()).unwrap().is_some());
    }

    struct TestChild(Child);

    impl Drop for TestChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn wait_for_marker(path: &Path) {
        let started = Instant::now();
        while !path.exists() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "missing {path:?}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn replacement_waits_for_delayed_owner_exit_before_starting_runtime() {
        let directory = tempfile::tempdir().unwrap();
        let mut owner = TestChild(
            child_command(directory.path(), "delayed-owner")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        );
        wait_for_marker(&directory.path().join("owner-ready"));
        let mut replacement = TestChild(
            child_command(directory.path(), "replacement")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        );
        wait_for_marker(&directory.path().join("replacement-contended"));
        // The replacement has reached contention, yet the old process still
        // owns the runtime. Only its real exit may admit the replacement.
        assert!(owner.0.try_wait().unwrap().is_none());
        assert!(replacement.0.try_wait().unwrap().is_none());
        assert!(!directory.path().join("runtime-started").exists());
        owner.0.stdin.take().unwrap().write_all(b"exit").unwrap();
        assert!(owner.0.wait().unwrap().success());
        replacement
            .0
            .stdin
            .take()
            .unwrap()
            .write_all(b"retry")
            .unwrap();
        assert!(replacement.0.wait().unwrap().success());
        assert!(directory.path().join("runtime-started").exists());
        assert!(InstanceLease::acquire(directory.path()).unwrap().is_some());
    }

    #[test]
    fn live_owner_keeps_exclusivity_after_a_bounded_handoff_wait() {
        let directory = tempfile::tempdir().unwrap();
        let _owner = InstanceLease::acquire(directory.path()).unwrap().unwrap();
        let timeout = Duration::from_millis(50);
        let started = Instant::now();
        assert!(
            InstanceLease::acquire_with_timeout(directory.path(), timeout)
                .unwrap()
                .is_none()
        );
        assert!(started.elapsed() >= timeout);
        assert!(!directory.path().join("runtime-started").exists());
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
        assert!(run[..plugin].contains(
            "#[cfg(any(target_os = \"macos\", target_os = \"windows\"))]\n    let builder = builder"
        ));
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

    #[test]
    fn linux_startup_does_not_require_the_activation_plugins_dbus_connection() {
        let manifest = include_str!("../Cargo.toml");
        let dependency = manifest
            .split_once("tauri-plugin-single-instance.workspace = true")
            .unwrap()
            .0;
        let target = dependency.rsplit_once("[target.").unwrap().1.trim();
        assert_eq!(
            target,
            "'cfg(any(target_os = \"macos\", target_os = \"windows\"))'.dependencies]"
        );
        // The startup-order test separately keeps the OS lease unconditional
        // for desktop builds, including Linux without a session bus.
        let source = include_str!("lib.rs");
        assert!(source.contains(
            "#[cfg(desktop)]\n            match application_instance::InstanceLease::acquire(&app_dir)?"
        ));
    }
}
