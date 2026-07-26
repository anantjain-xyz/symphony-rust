import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export type {
  DownloadEvent as DesktopDownloadEvent,
  Update as DesktopUpdate,
} from "@tauri-apps/plugin-updater";

export function checkForDesktopUpdate() {
  return check();
}

export function relaunchDesktopApp() {
  return relaunch();
}
