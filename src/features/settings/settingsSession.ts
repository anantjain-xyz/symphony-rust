import type { AppSettings } from "../../bindings";
import type { SettingsValidationController } from "../../settingsValidationController";

export function createSettingsSession(
  notifyDirty: (dirty: boolean) => void,
  notifySaving: (saving: boolean) => void,
) {
  let draft: AppSettings | null = null;
  let key = "";
  let revision = 0;
  let dirty = false;
  let saving = false;
  let saveOwner: SettingsValidationController | null = null;
  return {
    readDraft: () => draft,
    replaceDraft(next: AppSettings) {
      draft = next;
    },
    readKey: () => key,
    replaceKey(next: string) {
      key = next;
    },
    revision: () => revision,
    advanceRevision: () => ++revision,
    isDirty: () => dirty,
    setDirty(next: boolean) {
      if (dirty === next) return;
      dirty = next;
      notifyDirty(next);
    },
    isSaving: () => saving,
    ownsSave: (owner: SettingsValidationController | null) => saveOwner === owner,
    beginSave(owner: SettingsValidationController) {
      if (saving) return false;
      saving = true;
      saveOwner = owner;
      notifySaving(true);
      return true;
    },
    finishSave(owner: SettingsValidationController) {
      if (saveOwner !== owner) return;
      saving = false;
      saveOwner = null;
      notifySaving(false);
    },
    acceptSaved(next: AppSettings) {
      if (!dirty) draft = next;
    },
  };
}
export type SettingsSession = ReturnType<typeof createSettingsSession>;
