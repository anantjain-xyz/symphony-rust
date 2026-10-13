import { describe, expect, it, vi } from "vitest";
import { previewRuntime } from "../../preview/runtime";
import { createSettingsSession } from "./settingsSession";

function settings(settings_revision: number, prompt_template = "Saved prompt") {
  return { ...previewRuntime.settings, settings_revision, prompt_template };
}

function sessionWithDraft() {
  const session = createSettingsSession(vi.fn(), vi.fn());
  session.acceptSaved(settings(4));
  session.replaceDraft(settings(4, "Edited prompt"));
  session.setDirty(true);
  return session;
}

describe("settings draft provenance", () => {
  it("acknowledges the completed save while retaining its descendant edits", () => {
    const session = sessionWithDraft();
    const submitted = session.readDraft()!;
    const source = session.captureDraftLineage(submitted);
    session.replaceDraft(settings(4, "Edited again while saving"));

    expect(session.acknowledgeSave(source, { ...submitted, settings_revision: 5 })).toBe(true);
    expect(session.readDraft()).toMatchObject({
      settings_revision: 5,
      prompt_template: "Edited again while saving",
    });
    expect(session.isDirty()).toBe(true);
  });

  it("does not adopt an unrelated saved revision into a dirty draft", () => {
    const session = sessionWithDraft();
    session.acceptSaved(settings(5, "Retro workflow"));

    expect(session.readDraft()).toMatchObject({
      settings_revision: 4,
      prompt_template: "Edited prompt",
    });
    expect(session.isDirty()).toBe(true);
  });

  it("rejects an acknowledgement after its draft lineage was replaced", () => {
    const session = sessionWithDraft();
    const submitted = session.readDraft()!;
    const source = session.captureDraftLineage(submitted);
    session.setDirty(false);
    session.acceptSaved(settings(4));
    session.replaceDraft(settings(4, "Edit of the replacement draft"));
    session.setDirty(true);

    expect(session.acknowledgeSave(source, { ...submitted, settings_revision: 5 })).toBe(false);
    expect(session.readDraft()).toMatchObject({
      settings_revision: 4,
      prompt_template: "Edit of the replacement draft",
    });
  });
});
