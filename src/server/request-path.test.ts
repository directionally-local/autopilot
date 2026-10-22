import { describe, it } from "node:test";
import assert from "node:assert";
import { hasDotSegment, requestPathname } from "./request-path.js";

describe("requestPathname", () => {
  it("normalizes the way the routers do", () => {
    assert.equal(requestPathname({ url: "/api/v1/../../prompt" }), "/prompt");
    assert.equal(requestPathname({ url: "/api/v1/%2e%2e/%2E%2E/prompt" }), "/prompt");
    assert.equal(requestPathname({ url: "/api/v1/..\\..\\prompt" }), "/prompt");
    assert.equal(requestPathname({ url: "/api/v1/runs?x=1" }), "/api/v1/runs");
  });
});

describe("hasDotSegment", () => {
  it("flags dot segments in every spelling", () => {
    for (const u of ["/api/v1/../prompt", "/a/./b", "/api/v1/%2e%2e/x", "/api/v1/%2E./x", "/api/v1/..\\x", "/.."]) {
      assert.equal(hasDotSegment(u), true, u);
    }
  });

  it("leaves ordinary paths and dots in names or queries alone", () => {
    for (const u of ["/session", "/api/v1/runs", "/file/a.b..c", "/x?path=../y", "/"]) {
      assert.equal(hasDotSegment(u), false, u);
    }
  });
});
