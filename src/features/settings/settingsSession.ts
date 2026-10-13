import type { AppSettings } from "../../bindings";
import type { SettingsValidationController } from "../../settingsValidationController";
import { formSnapshot } from "../../viewPrimitives";

type DraftLineage = { lineage: object; settingsRevision: number };
type KeyRemovalSource = DraftLineage & { keyRevision: number };

export function createSettingsSession(
  notifyDirty: (dirty: boolean) => void,
  notifySaving: (saving: boolean) => void,
) {
  let draft: AppSettings | null = null;
  let draftBase: AppSettings | null = null;
  let latestSaved: AppSettings | null = null;
  let lineage = {};
  let key = "";
  let keyRevision = 0;
  let revision = 0;
  let dirty = false;
  let saving = false;
  let saveOwner: SettingsValidationController | null = null;
  function setDirty(next: boolean) {
    if (dirty === next) return;
    dirty = next;
    notifyDirty(next);
  }
  function adoptSaved(next: AppSettings) {
    draft = next;
    draftBase = next;
    lineage = {};
  }
  function recordSaved(next: AppSettings) {
    if (latestSaved && next.settings_revision < latestSaved.settings_revision) return false;
    latestSaved = next;
    return true;
  }
  return {
    readDraft: () => draft,
    readSaved: () => latestSaved,
    replaceDraft(next: AppSettings) {
      draft = next;
    },
    captureDraftLineage(source: AppSettings) {
      return { lineage, settingsRevision: source.settings_revision };
    },
    captureKeyRemoval(source: AppSettings): KeyRemovalSource {
      return { lineage, settingsRevision: source.settings_revision, keyRevision };
    },
    acknowledgeSave(source: DraftLineage, saved: AppSettings) {
      if (!recordSaved(saved)) return false;
      if (
        !draft ||
        source.lineage !== lineage ||
        draft.settings_revision !== source.settingsRevision
      ) {
        return false;
      }
      draft = {
        ...draft,
        settings_revision: saved.settings_revision,
        linear_api_key_set: saved.linear_api_key_set,
        linear_api_key_error: saved.linear_api_key_error,
      };
      draftBase = saved;
      setDirty(formSnapshot(draft) !== formSnapshot(saved) || key.trim() !== "");
      return true;
    },
    completeKeyRemoval(source: KeyRemovalSource | null, saved: AppSettings) {
      // A later published snapshot wins over a delayed removal response.
      if (!recordSaved(saved)) return false;
      const hasFormEdits = draft && draftBase && formSnapshot(draft) !== formSnapshot(draftBase);
      if (source?.keyRevision === keyRevision) key = "";
      if (!hasFormEdits || (draft && formSnapshot(draft) === formSnapshot(saved))) {
        adoptSaved(saved);
        setDirty(key.trim() !== "");
      } else if (draft) {
        if (source?.lineage === lineage && draft.settings_revision === source.settingsRevision) {
          const directlyFollows = saved.settings_revision === source.settingsRevision + 1;
          draft = {
            ...draft,
            settings_revision: directlyFollows ? saved.settings_revision : draft.settings_revision,
            linear_api_key_set: saved.linear_api_key_set,
            linear_api_key_error: saved.linear_api_key_error,
          };
          if (directlyFollows) draftBase = saved;
        }
        setDirty(true);
      }
      return true;
    },
    readKey: () => key,
    replaceKey(next: string) {
      key = next;
      keyRevision += 1;
    },
    revision: () => revision,
    advanceRevision: () => ++revision,
    isDirty: () => dirty,
    setDirty,
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
      if (!recordSaved(next)) return false;
      if (!dirty || (draft && formSnapshot(draft) === formSnapshot(next))) {
        adoptSaved(next);
        setDirty(key.trim() !== "");
      }
      return true;
    },
  };
}
export type SettingsSession = ReturnType<typeof createSettingsSession>;
