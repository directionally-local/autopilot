import { describe, it } from "node:test";
import assert from "node:assert";
import { computeModalFlags, EMPTY_MODAL_STATE } from "./use-modal-host.js";

describe("computeModalFlags", () => {
  it("returns all-false for an empty state", () => {
    const f = computeModalFlags(EMPTY_MODAL_STATE);
    assert.deepStrictEqual(f, {
      hasFullscreenModal: false,
      hasOverlayModal: false,
      hasAnyModal: false,
    });
  });

  it("flags command wizard as fullscreen", () => {
    const f = computeModalFlags({
      ...EMPTY_MODAL_STATE,
      commandWizard: { mode: "create" },
    });
    assert.strictEqual(f.hasFullscreenModal, true);
    assert.strictEqual(f.hasOverlayModal, false);
    assert.strictEqual(f.hasAnyModal, true);
  });

  it("flags each boolean fullscreen modal", () => {
    for (const key of [
      "showCommandList",
      "showLspWizard",
      "showThemePicker",
      "showInboxModal",
    ] as const) {
      const f = computeModalFlags({ ...EMPTY_MODAL_STATE, [key]: true });
      assert.strictEqual(f.hasFullscreenModal, true, `${key} should be fullscreen`);
      assert.strictEqual(f.hasOverlayModal, false, `${key} should not be overlay`);
    }
  });

  it("flags command picker / command-to-delete as fullscreen", () => {
    const f1 = computeModalFlags({
      ...EMPTY_MODAL_STATE,
      commandPicker: { mode: "delete" },
    });
    assert.strictEqual(f1.hasFullscreenModal, true);

    const f2 = computeModalFlags({
      ...EMPTY_MODAL_STATE,
      commandToDelete: {
        name: "foo",
        template: "",
        source: "project",
        filepath: "/tmp/foo.md",
      },
    });
    assert.strictEqual(f2.hasFullscreenModal, true);
  });

  it("combines flags when both overlay and fullscreen are open", () => {
    const f = computeModalFlags({
      ...EMPTY_MODAL_STATE,
      showPlanCompletePicker: true,
      showLspWizard: true,
    });
    assert.deepStrictEqual(f, {
      hasFullscreenModal: true,
      hasOverlayModal: true,
      hasAnyModal: true,
    });
  });

  it("flags plan complete picker as overlay, not fullscreen", () => {
    const f = computeModalFlags({
      ...EMPTY_MODAL_STATE,
      showPlanCompletePicker: true,
    });
    assert.strictEqual(f.hasOverlayModal, true);
    assert.strictEqual(f.hasFullscreenModal, false);
    assert.strictEqual(f.hasAnyModal, true);
  });
});
