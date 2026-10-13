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

  it("recomputes dirtiness when an in-flight save changes the saved baseline", () => {
    const session = sessionWithDraft();
    const submitted = session.readDraft()!;
    const source = session.captureDraftLineage(submitted);
    session.replaceDraft(settings(4));
    session.setDirty(false);

    expect(session.acknowledgeSave(source, { ...submitted, settings_revision: 5 })).toBe(true);
    expect(session.readDraft()).toMatchObject({
      settings_revision: 5,
      prompt_template: "Saved prompt",
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

  it("adopts the fresh snapshot when removing a replacement key leaves no form edits", () => {
    const session = createSettingsSession(vi.fn(), vi.fn());
    session.acceptSaved(settings(4));
    session.replaceKey("replacement-key");
    session.setDirty(true);
    const source = session.captureKeyRemoval(session.readDraft()!);
    const removed = { ...settings(6, "Another writer's prompt"), linear_api_key_set: false };

    expect(session.completeKeyRemoval(source, removed)).toBe(true);
    expect(session.readDraft()).toEqual(removed);
    expect(session.readKey()).toBe("");
    expect(session.isDirty()).toBe(false);
  });

  it.each(["newer-key", "original-key"])(
    "preserves a later key edit ending in %s when removal finishes",
    (replacement) => {
      const session = createSettingsSession(vi.fn(), vi.fn());
      session.acceptSaved(settings(4));
      session.replaceKey("original-key");
      session.setDirty(true);
      const source = session.captureKeyRemoval(session.readDraft()!);
      session.replaceKey("intermediate-key");
      session.replaceKey(replacement);
      const removed = { ...settings(6, "Another writer's prompt"), linear_api_key_set: false };

      expect(session.completeKeyRemoval(source, removed)).toBe(true);
      expect(session.readDraft()).toEqual(removed);
      expect(session.readKey()).toBe(replacement);
      expect(session.isDirty()).toBe(true);
    },
  );

  it("preserves actual form edits at their old revision after a skipped removal revision", () => {
    const session = sessionWithDraft();
    session.replaceKey("replacement-key");
    const source = session.captureKeyRemoval(session.readDraft()!);
    const removed = { ...settings(6, "Another writer's prompt"), linear_api_key_set: false };

    expect(session.completeKeyRemoval(source, removed)).toBe(true);
    expect(session.readDraft()).toMatchObject({
      settings_revision: 4,
      prompt_template: "Edited prompt",
      linear_api_key_set: false,
      linear_api_key_error: null,
    });
    expect(session.readKey()).toBe("");
    expect(session.isDirty()).toBe(true);
  });

  it("ignores a removal response older than an already published snapshot", () => {
    const session = createSettingsSession(vi.fn(), vi.fn());
    session.acceptSaved(settings(4));
    const source = session.captureKeyRemoval(session.readDraft()!);
    const newer = { ...settings(6, "Newer saved prompt"), linear_api_key_set: true };
    session.acceptSaved(newer);

    expect(session.completeKeyRemoval(source, { ...settings(5), linear_api_key_set: false })).toBe(
      false,
    );
    expect(session.readDraft()).toEqual(newer);
    expect(session.isDirty()).toBe(false);
  });

  it("refreshes credential metadata only for an acknowledged save lineage", () => {
    const session = sessionWithDraft();
    const submitted = session.readDraft()!;
    const source = session.captureDraftLineage(submitted);
    const saved = {
      ...submitted,
      settings_revision: 5,
      linear_api_key_error: "Keychain unavailable",
    };
    session.replaceDraft({ ...submitted, prompt_template: "Another edit while saving" });

    expect(session.acknowledgeSave(source, saved)).toBe(true);
    expect(session.readDraft()?.linear_api_key_error).toBe("Keychain unavailable");
    session.acceptSaved({ ...saved, settings_revision: 6, linear_api_key_error: null });
    expect(session.readDraft()?.linear_api_key_error).toBe("Keychain unavailable");
    expect(session.readDraft()?.settings_revision).toBe(5);
  });

  it("keeps the newer saved baseline when an older save or reload finishes late", () => {
    const session = sessionWithDraft();
    const source = session.captureKeyRemoval(session.readDraft()!);
    const newer = settings(6, "A newer published workflow");
    session.acceptSaved(newer);
    const lateSave = settings(5, "Edited prompt");

    expect(session.acknowledgeSave(source, lateSave)).toBe(false);
    expect(session.readSaved()).toBe(newer);
    expect(session.acceptSaved(lateSave)).toBe(false);
    expect(session.readSaved()).toBe(newer);
    expect(session.readDraft()).toMatchObject({
      settings_revision: 4,
      prompt_template: "Edited prompt",
    });
    expect(session.completeKeyRemoval(source, lateSave)).toBe(false);
  });
});
