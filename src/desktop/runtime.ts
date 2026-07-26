import { isTauri } from "@tauri-apps/api/core";

export function isDesktopRuntime() {
  return isTauri();
}
