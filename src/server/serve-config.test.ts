import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KimiConfig } from "../config.js";
import { resolveServeConfig } from "./serve-config.js";

describe("autopilot serve config", () => {
  it("uses the provider config when there is one", () => {
    const cfg = { model: "test/model", openrouterApiKey: "sk-or-test" } as KimiConfig;
    assert.deepEqual(resolveServeConfig(cfg, {}), { config: cfg, asterOnly: false });
  });

  it("serves the Aster API without a host provider key when Hotcell brings the model", () => {
    const resolved = resolveServeConfig(null, { AUTOPILOT_HOTCELL_ENDPOINT: "http://127.0.0.1:4750" });
    assert.equal(resolved?.asterOnly, true);
    assert.ok(resolved?.config.model);
    assert.equal(resolved?.config.openrouterApiKey, undefined);
  });

  it("still refuses with neither credentials nor Hotcell", () => {
    assert.equal(resolveServeConfig(null, {}), undefined);
    assert.equal(resolveServeConfig(null, { AUTOPILOT_HOTCELL_ENDPOINT: " " }), undefined);
  });
});
