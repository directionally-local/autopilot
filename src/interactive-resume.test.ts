import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInteractiveResume, resumeHint } from "./interactive-resume.js";

describe("interactive resume", () => {
  let dataHome: string;
  const saved = process.env.XDG_DATA_HOME;
  const session = (id: string, cwd: string, updatedAt: string) =>
    writeFile(
      join(dataHome, "kimiflare", "sessions", `${id}.json`),
      JSON.stringify({ id, cwd, model: "m", createdAt: updatedAt, updatedAt, messages: [{ role: "user", content: "hi" }] }),
    );

  before(async () => {
    dataHome = await mkdtemp(join(tmpdir(), "resume-"));
    process.env.XDG_DATA_HOME = dataHome;
    await mkdir(join(dataHome, "kimiflare", "sessions"), { recursive: true });
    await session("2026-10-01T10-00-00-000Z_old", "/work/a", "2026-10-01T10:00:00.000Z");
    await session("2026-10-02T10-00-00-000Z_new", "/work/a", "2026-10-02T10:00:00.000Z");
    await session("2026-10-03T10-00-00-000Z_other", "/work/b", "2026-10-03T10:00:00.000Z");
  });
  after(async () => {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
    await rm(dataHome, { recursive: true, force: true });
  });

  it("opens a session by id (with or without .json)", async () => {
    assert.deepStrictEqual(await resolveInteractiveResume({ sessionId: "2026-10-01T10-00-00-000Z_old" }), { kind: "session", sessionId: "2026-10-01T10-00-00-000Z_old" });
    assert.deepStrictEqual(await resolveInteractiveResume({ sessionId: "2026-10-01T10-00-00-000Z_old.json" }), { kind: "session", sessionId: "2026-10-01T10-00-00-000Z_old" });
  });

  it("rejects unknown ids and paths", async () => {
    for (const sessionId of ["nope", "../../etc/passwd", "a/b"]) {
      const r = await resolveInteractiveResume({ sessionId });
      assert.strictEqual(r.kind, "error", sessionId);
    }
  });

  it("-c continues the most recent session in this directory", async () => {
    assert.deepStrictEqual(await resolveInteractiveResume({ latest: true }, "/work/a"), { kind: "session", sessionId: "2026-10-02T10-00-00-000Z_new" });
    assert.strictEqual((await resolveInteractiveResume({ latest: true }, "/work/none")).kind, "error");
  });

  it("with neither, shows the picker", async () => {
    assert.deepStrictEqual(await resolveInteractiveResume({}), { kind: "picker" });
  });

  it("prints a hint that names a command that reopens the saved session", async () => {
    assert.strictEqual(resumeHint("2026-10-02T10-00-00-000Z_new"), "Resume this conversation with: autopilot resume 2026-10-02T10-00-00-000Z_new\n");
    assert.strictEqual(resumeHint("never-saved"), null);
    assert.strictEqual(resumeHint(null), null);
  });
});
