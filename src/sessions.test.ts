import { describe, it } from "node:test";
import assert from "node:assert";
import { readFile, readdir, stat } from "node:fs/promises";
import type { ChatMessage } from "./agent/messages.js";
import { addCheckpoint, listSessions, loadSession, saveSession, sessionsDir, type SessionFile } from "./sessions.js";

function session(id: string, messages: ChatMessage[]): SessionFile {
  const now = new Date().toISOString();
  return { id, cwd: "/repo", model: "m", createdAt: now, updatedAt: now, messages };
}

function messages(n: number, size: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i} ${"x".repeat(size)}` }) as ChatMessage);
}

describe("saveSession (T4-01)", () => {
  it("never leaves a torn file when large and small saves race, and the last save wins", async () => {
    const id = "race-session";
    const big = session(id, messages(200, 8_000)); // ~1.6 MB
    const small = session(id, messages(2, 10));
    const writes: Promise<string>[] = [];
    for (let i = 0; i < 10; i++) writes.push(saveSession(i % 2 ? small : big));
    writes.push(saveSession(small));
    const paths = await Promise.all(writes);
    const loaded = JSON.parse(await readFile(paths[0]!, "utf8")) as SessionFile;
    assert.equal(loaded.messages.length, 2, "the save issued last is the one on disk");
    const listed = await listSessions(30);
    assert.ok(listed.some((s) => s.id === id), "still listed for /resume");
    assert.ok(!(await readdir(sessionsDir())).some((f) => f.endsWith(".tmp")), "no temp files left behind");
  });

  it("writes session files owner-only", async () => {
    if (process.platform === "win32") return;
    const path = await saveSession(session("mode-session", messages(1, 1)));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it("snapshots the session at call time, not when its queued write runs", async () => {
    const file = session("snapshot-session", messages(1, 1));
    const pending = saveSession(file);
    file.messages.push({ role: "assistant", content: "later" } as ChatMessage);
    const path = await pending;
    const loaded = JSON.parse(await readFile(path, "utf8")) as SessionFile;
    assert.equal(loaded.messages.length, 1);
  });

  it("concurrent checkpoints are all kept (no lost read-modify-write)", async () => {
    const file = session("checkpoint-session", messages(4, 100));
    const path = await saveSession(file);
    const at = new Date().toISOString();
    await Promise.all(
      ["cp1", "cp2", "cp3", "cp4"].map((id, i) => addCheckpoint(path, { id, label: id, turnIndex: i, timestamp: at } as never)),
    );
    const after = await loadSession(path);
    assert.deepStrictEqual(after.checkpoints?.map((c) => c.id), ["cp1", "cp2", "cp3", "cp4"]);
    assert.equal(after.messages.length, 4);
  });
});
