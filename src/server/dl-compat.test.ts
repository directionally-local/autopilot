import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serverEnv } from "./dl-compat.js";

describe("dl server legacy names", () => {
  it("prefers the new environment variable and falls back to the pre-rename one", () => {
    assert.equal(serverEnv({ AUTOPILOT_SERVER_DB: "/new.db" }, "DB"), "/new.db");
    assert.equal(serverEnv({ AUTOPILOT_ASTER_DB: "/old.db" }, "DB"), "/old.db");
    assert.equal(serverEnv({ AUTOPILOT_SERVER_DB: "/new.db", AUTOPILOT_ASTER_DB: "/old.db" }, "DB"), "/new.db");
    assert.equal(serverEnv({ AUTOPILOT_SERVER_DB: "  " }, "DB"), undefined);
    assert.equal(serverEnv({}, "DB"), undefined);
  });
});
