import { getVersion } from "@tauri-apps/api/app";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

export function getDesktopVersion() {
  return getVersion();
}

export function openExternalUrl(url: string) {
  return openUrl(url);
}

export function revealDesktopPath(path: string) {
  return revealItemInDir(path);
}
