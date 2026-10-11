import assert from "node:assert/strict";
import test from "node:test";
import { workerLogPreview } from "./worker-list.js";

test("hides routine worker logs while work is running or complete", () => {
  const logs = ["worker started", "polling for progress"];

  assert.equal(workerLogPreview({ status: "running", logs }), undefined);
  assert.equal(workerLogPreview({ status: "completed", logs }), undefined);
});

test("shows one concise log line when a worker fails", () => {
  assert.equal(
    workerLogPreview({ status: "failed", logs: ["starting", "request failed"] }),
    "request failed",
  );
  assert.equal(
    workerLogPreview({ status: "failed", logs: ["request\nfailed"] }),
    "request failed",
  );
  assert.equal(
    workerLogPreview({ status: "budget_exhausted", logs: ["x".repeat(200)] })?.length,
    120,
  );
});
