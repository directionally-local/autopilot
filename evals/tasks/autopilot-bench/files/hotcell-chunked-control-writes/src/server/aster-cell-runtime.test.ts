import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AsterHotcellRuntime } from "./aster-cell-runtime.js";
import type { HotcellProvider } from "./hotcell-provider.js";
import type { AsterTurnStart } from "./aster-api.js";

const CONTROL_PREFIX = "node --input-type=module";

interface FakeCellState {
  id: string;
  files: Map<string, string>;
  processes: Array<{ command: string; status: string }>;
  sessions: string[];
  prompts: Array<{ id: string; message: string }>;
  aborts: number;
  events: Array<{ cursor: number; runId: string | null; event: Record<string, unknown> }>;
  destroyed: boolean;
  paused: number;
  started: number;
  modelSwitches?: string[];
  commands?: string[];
  writeSizes?: number[];
  activeRunId?: string | null;
}

function fakeSandbox(state: FakeCellState) {
  const exec = async (command: string) => {
    (state.commands ??= []).push(command);
    if (command.startsWith("test -f ")) {
      return { exitCode: state.files.has(command.slice("test -f ".length)) ? 0 : 1, stdout: "", stderr: "", success: true };
    }
    if (command.startsWith("cat ") && command.includes(" | base64 -d > ")) {
      const [partList, destination] = command.slice("cat ".length).split(" | base64 -d > ");
      const partPaths = partList!.split("'").map((path) => path.trim()).filter(Boolean);
      const target = destination!.split("'")[1]!;
      const encoded = partPaths.map((path) => state.files.get(path) ?? "").join("");
      state.files.set(target, Buffer.from(encoded, "base64").toString("utf8"));
      return { exitCode: 0, stdout: "", stderr: "", success: true };
    }
    if (command.startsWith("rm -rf ")) {
      const directory = command.slice("rm -rf ".length).split("'")[1]!;
      for (const path of state.files.keys()) if (path.startsWith(`${directory}/`)) state.files.delete(path);
      return { exitCode: 0, stdout: "", stderr: "", success: true };
    }
    if (command.startsWith(CONTROL_PREFIX)) {
      const requestId = command.trim().split(" ").pop()!;
      const raw = state.files.get(`/workspace/.aster/control/${requestId}.json`);
      state.files.delete(`/workspace/.aster/control/${requestId}.json`);
      if (!raw) return { exitCode: 1, stdout: JSON.stringify({ error: "missing_request" }), stderr: "", success: false };
      const request = JSON.parse(raw) as { method: string; path: string; body?: Record<string, unknown> };
      const respond = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value) + "\n", stderr: "", success: true });
      if (request.method === "GET" && request.path === "/health") {
        return respond(state.processes.some((proc) => proc.status === "running") ? { ok: true } : { error: "not_ready" });
      }
      if (request.method === "GET" && request.path === "/status") {
        return respond({ initialized: true, sessionId: "s", activeRunId: state.activeRunId ?? null, cursor: state.events.at(-1)?.cursor ?? 0 });
      }
      if (request.method === "GET" && request.path.startsWith("/events?after=")) {
        const after = Number(request.path.slice("/events?after=".length));
        return respond({ events: state.events.filter((entry) => entry.cursor > after), cursor: state.events.at(-1)?.cursor ?? 0, hasMore: false });
      }
      if (request.method === "POST" && request.path === "/rpc") {
        const body = request.body!;
        if (body.type === "new_session") { state.sessions.push(String(body.sessionId)); return respond({ type: "ok", id: body.id }); }
        if (body.type === "prompt") {
          state.prompts.push({ id: String(body.id), message: String(body.message) });
          queueMicrotask(() => {
            state.events.push({ cursor: state.events.length + 1, runId: String(body.id), event: { type: "message.delta", text: "cell reply" } });
            state.events.push({ cursor: state.events.length + 1, runId: String(body.id), event: { type: "session.end", reason: "complete" } });
          });
          return respond({ type: "ok", id: body.id });
        }
        if (body.type === "set_model") {
          (state.modelSwitches ??= []).push(String(body.modelId));
          return respond({ type: "ok", id: body.id });
        }
        if (body.type === "abort") {
          state.aborts++;
          state.events.push({ cursor: state.events.length + 1, runId: null, event: { type: "session.end", reason: "aborted" } });
          return respond({ type: "ok", id: body.id });
        }
      }
      return { exitCode: 1, stdout: JSON.stringify({ error: "unsupported" }), stderr: "", success: false };
    }
    if (command.startsWith("base64 -d ")) return { exitCode: 0, stdout: "", stderr: "", success: true };
    if (command.startsWith("rm -f ")) {
      state.files.set("/workspace/.aster/.seeded", "1");
      return { exitCode: 0, stdout: "", stderr: "", success: true };
    }
    if (command.startsWith("mkdir -p ") || command.startsWith("npm install ")) {
      return { exitCode: 0, stdout: "", stderr: "", success: true };
    }
    return { exitCode: 0, stdout: "", stderr: "", success: true };
  };
  return {
    getInfo: () => ({ id: state.id }),
    exec,
    writeFile: async (path: string, content: string) => {
      const size = Buffer.byteLength(content, "utf8");
      (state.writeSizes ??= []).push(size);
      // Mirror the Hotcell container driver: oversized payloads become a too-long shell argument.
      if (size > 96 * 1024) throw new Error("E2BIG: argument list too long");
      state.files.set(path, content);
    },
    readFile: async (path: string) => {
      const value = state.files.get(path);
      if (value === undefined) throw new Error("not found");
      return value;
    },
    mkdir: async () => {},
    listProcesses: async () => state.processes.map((proc, index) => ({ ...proc, procId: `proc-${index}`, pid: 1, exitCode: null, startedAt: "", logPath: "" })),
    startProcess: async (command: string) => {
      state.processes.push({ command, status: "running" });
      return { procId: `proc-${state.processes.length}`, pid: 1, command, status: "running" as const, exitCode: null, startedAt: "", logPath: "" };
    },
    destroy: async () => { state.destroyed = true; },
    pause: async () => { state.paused++; },
    start: async () => { state.started++; },
    listEgressTokens: async () => ({ tokens: [], providers: [] }),
    revokeEgressToken: async () => {},
  };
}

/**
 * A fake cell whose /workspace is a real temp directory: control traffic stays faked,
 * every other command runs in a real shell so git checkpoint behavior is exercised.
 */
function realWorkspaceSandbox(state: FakeCellState, root: string) {
  const fake = fakeSandbox(state);
  const mapPath = (value: string) => value.replaceAll("/workspace", root);
  return {
    ...fake,
    exec: async (command: string) => {
      // Control traffic and runtime installs stay faked; only workspace commands run for real.
      if (command.startsWith(CONTROL_PREFIX) || command.startsWith("mkdir -p /opt/autopilot")) return fake.exec(command);
      try {
        const stdout = execSync(mapPath(command), { shell: "/bin/bash", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { exitCode: 0, stdout, stderr: "", success: true };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", success: false };
      }
    },
    writeFile: async (path: string, content: string) => {
      if (path.startsWith("/workspace/.aster/control/")) return fake.writeFile(path, content);
      mkdirSync(dirname(mapPath(path)), { recursive: true });
      writeFileSync(mapPath(path), content);
    },
    readFile: async (path: string) => {
      if (!path.startsWith("/workspace/")) return fake.readFile(path);
      return readFileSync(mapPath(path), "utf8");
    },
  };
}

function realWorkspaceProvider(state: FakeCellState, root: string): HotcellProvider {
  return {
    getCell: async () => realWorkspaceSandbox(state, root) as never,
  } as unknown as HotcellProvider;
}

function emptyCellState(id = "real-cell"): FakeCellState {
  return {
    id, files: new Map(), processes: [{ command: "startAsterCellBridge", status: "running" }], sessions: [], prompts: [],
    aborts: 0, events: [], destroyed: false, paused: 0, started: 0,
  };
}

function fakeProvider(cells: Map<string, FakeCellState>): HotcellProvider {
  let next = 0;
  return {
    findConversationCell: async (conversationId: string) => {
      const state = cells.get(conversationId);
      return state ? fakeSandbox(state) : undefined;
    },
    createConversationCell: async (input: { conversationId: string }) => {
      const existing = cells.get(input.conversationId);
      if (existing) return fakeSandbox(existing);
      const state: FakeCellState = {
        id: `fake-cell-${++next}`,
        files: new Map(), processes: [], sessions: [], prompts: [], aborts: 0, events: [],
        destroyed: false, paused: 0, started: 0,
      };
      cells.set(input.conversationId, state);
      return fakeSandbox(state);
    },
    getCell: async (cellId: string) => {
      for (const state of cells.values()) if (state.id === cellId) return fakeSandbox(state) as never;
      throw new Error("cell not found");
    },
    destroyConversationCell: async (cellId: string) => {
      for (const [key, state] of cells) if (state.id === cellId) { state.destroyed = true; cells.delete(key); }
    },
    pauseConversationCell: async (cellId: string) => {
      for (const state of cells.values()) if (state.id === cellId) state.paused++;
    },
    resumeConversationCell: async (cellId: string) => {
      for (const state of cells.values()) if (state.id === cellId) state.started++;
    },
  } as unknown as HotcellProvider;
}

function fakeTurn(overrides: Partial<AsterTurnStart>): AsterTurnStart & { events: Array<{ type: string; data?: Record<string, unknown> }>; finished: string[]; cursors: number[] } {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const finished: string[] = [];
  const cursors: number[] = [];
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    conversation: { id: "conv", sessionId: "session" } as never,
    cellId: "cell",
    cellEventCursor: 0,
    userText: "hello cell",
    sessionFile: { messages: [] } as never,
    messages: [],
    executor: {} as never,
    allowedTools: new Set(),
    maxToolIterations: null,
    maxRuntimeMs: null,
    askPermission: async () => "deny",
    publishEvent: (type, data) => { events.push({ type, data }); },
    onCellCursor: (cursor) => { cursors.push(cursor); },
    finish: (status) => { finished.push(status); },
    events,
    finished,
    cursors,
    ...overrides,
  };
}

describe("Aster Hotcell runtime", () => {
  it("provisions distinct cells per conversation, adopts on retry, and reuses the seeded workspace", async () => {
    const cells = new Map<string, FakeCellState>();
    const runtime = new AsterHotcellRuntime(fakeProvider(cells), { archiveWorkspace: async () => "QUJD" });

    const base = { sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo", model: "test/model", allowCreate: true, onCellCreated: () => {} };
    const first = await runtime.provisionConversation({ conversationId: crypto.randomUUID(), ...base });
    const second = await runtime.provisionConversation({ conversationId: crypto.randomUUID(), ...base });
    assert.notEqual(first.cellId, second.cellId);

    const conversationId = crypto.randomUUID();
    let recordedId: string | undefined;
    const created = await runtime.provisionConversation({ conversationId, ...base, onCellCreated: (id) => { recordedId = id; } });
    assert.equal(recordedId, created.cellId);
    const state = [...cells.values()].find((cell) => cell.id === created.cellId)!;
    assert.deepEqual(state.sessions, ["s-1"]);
    assert.equal(state.processes.filter((proc) => proc.command.includes("startAsterCellBridge")).length, 1);

    // A retry after a create attempt adopts by label and never starts a second bridge or reseeds.
    const retried = await runtime.provisionConversation({ conversationId, ...base, allowCreate: false, onCellCreated: () => {} });
    assert.equal(retried.cellId, created.cellId);
    assert.deepEqual(state.sessions, ["s-1", "s-1"]); // new_session is idempotent in the bridge
    assert.equal(state.processes.length, 1);
    assert.ok(!state.prompts.some((prompt) => prompt.message.length > 0)); // provisioning never sends prompts
  });

  it("maps cell events to Aster events, advances the cursor, and finishes completed turns", async () => {
    const cells = new Map<string, FakeCellState>();
    const provider = fakeProvider(cells);
    const runtime = new AsterHotcellRuntime(provider, { archiveWorkspace: async () => "QUJD", pollIntervalMs: 5 });
    const conversationId = crypto.randomUUID();
    const { cellId } = await runtime.provisionConversation({
      conversationId, sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {},
    });
    const turn = fakeTurn({ cellId });
    runtime.startTurn(turn);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const state = [...cells.values()][0]!;
    assert.deepEqual(state.prompts, [{ id: turn.runId, message: "hello cell" }]);
    assert.ok(turn.events.some((event) => event.type === "assistant.delta"));
    assert.deepEqual(turn.finished, ["completed"]);
    assert.deepEqual(turn.cursors, [1, 2]);
  });

  it("sends 150k prompts through bounded Hotcell control-file writes", async () => {
    const cells = new Map<string, FakeCellState>();
    const runtime = new AsterHotcellRuntime(fakeProvider(cells), { archiveWorkspace: async () => "QUJD", pollIntervalMs: 5 });
    const { cellId } = await runtime.provisionConversation({
      conversationId: crypto.randomUUID(), sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {},
    });
    const userText = "Quarterly \u2014 r\u00e9sultats \u4e2d\u6587 \u{1F4C4}\n".repeat(6_000);
    const turn = fakeTurn({ cellId, userText });
    runtime.startTurn(turn);
    await waitFor(() => turn.finished.length > 0);

    const state = [...cells.values()][0]!;
    assert.equal(state.prompts.at(-1)?.message, userText);
    assert.deepEqual(turn.finished, ["completed"]);
    assert.ok(state.writeSizes?.length);
    assert.ok(Math.max(...state.writeSizes!) <= 32 * 1024);
    assert.ok(![...state.files.keys()].some((path) => path.includes(".parts/")));
  });

  it("cancels an active turn with an in-cell abort and completes pause/resume/destroy through the provider", async () => {
    const cells = new Map<string, FakeCellState>();
    const provider = fakeProvider(cells);
    const runtime = new AsterHotcellRuntime(provider, { archiveWorkspace: async () => "QUJD", pollIntervalMs: 5 });
    const conversationId = crypto.randomUUID();
    const { cellId } = await runtime.provisionConversation({
      conversationId, sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {},
    });
    const turn = fakeTurn({ cellId, runId: crypto.randomUUID() });
    runtime.startTurn(turn);
    runtime.cancelRun(turn.runId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = [...cells.values()][0]!;
    assert.equal(state.aborts, 1);
    assert.deepEqual(turn.finished, ["cancelled"]);

    await runtime.pauseCell(cellId);
    await runtime.resumeCell(cellId);
    assert.equal(state.paused, 1);
    assert.equal(state.started, 1);
    await runtime.destroyCell(cellId);
    assert.equal(state.destroyed, true);
  });

  it("streams tool commands and output, then checkpoints the turn's changes in git", async () => {
    const root = mkdtempSync(join(tmpdir(), "aster-cell-"));
    try {
      writeFileSync(join(root, "README.md"), "seed\n");
      const state = emptyCellState();
      state.events.push(
        { cursor: 1, runId: null, event: { type: "tool.start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la" } } },
        { cursor: 2, runId: null, event: { type: "tool.result", toolCallId: "t1", toolName: "bash", result: "README.md\nsk-or-v1-abcdefghijklmnopqrstuvwxyz", isError: false } },
      );
      const runtime = new AsterHotcellRuntime(realWorkspaceProvider(state, root), { pollIntervalMs: 5 });
      await runtime.listCheckpoints(state.id); // provisioning creates the repo before any turn
      // Simulate the agent's work landing in the workspace during the turn.
      writeFileSync(join(root, "hello.txt"), "made by the agent\n");
      const turn = fakeTurn({ cellId: state.id, userText: "list files\nand say hi" });
      runtime.startTurn(turn);
      await waitFor(() => turn.finished.length > 0);

      const started = turn.events.find((event) => event.type === "tool.activity" && event.data?.activity === "started");
      assert.deepEqual(started?.data, { tool: "bash", toolCallId: "t1", activity: "started", input: "ls -la" });
      const completed = turn.events.find((event) => event.type === "tool.activity" && event.data?.activity === "completed");
      assert.equal(completed?.data?.tool, "bash");
      assert.match(String(completed?.data?.output), /README\.md/);
      assert.doesNotMatch(String(completed?.data?.output), /sk-or-v1-/);

      const checkpointEvent = turn.events.find((event) => event.type === "checkpoint.created");
      assert.equal(checkpointEvent?.data?.message, "list files");
      assert.deepEqual(turn.finished, ["completed"]);
      // The checkpoint event is published before the terminal state.
      assert.ok(turn.events.indexOf(checkpointEvent!) >= 0);

      const checkpoints = await runtime.listCheckpoints(state.id);
      assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.message), ["list files", "Workspace created"]);
      assert.ok(!execSync("git ls-files", { cwd: root, encoding: "utf8" }).includes(".aster"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips empty checkpoints and restores a checkpoint as a new, undoable commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "aster-cell-"));
    try {
      writeFileSync(join(root, "a.txt"), "one\n");
      const state = emptyCellState();
      const runtime = new AsterHotcellRuntime(realWorkspaceProvider(state, root), { pollIntervalMs: 5 });
      const conversation = { id: "conv-restore", sessionId: "s" } as never;

      const first = fakeTurn({ cellId: state.id, conversation, userText: "noop turn" });
      runtime.startTurn(first);
      await waitFor(() => first.finished.length > 0);
      assert.ok(!first.events.some((event) => event.type === "checkpoint.created"));
      const [initial] = await runtime.listCheckpoints(state.id);

      writeFileSync(join(root, "a.txt"), "two\n");
      writeFileSync(join(root, "b.txt"), "new\n");
      const second = fakeTurn({ cellId: state.id, conversation, runId: crypto.randomUUID(), cellEventCursor: 2, userText: "change files" });
      runtime.startTurn(second);
      await waitFor(() => second.finished.length > 0);
      assert.ok(second.events.some((event) => event.type === "checkpoint.created"));

      const restored = await runtime.restoreCheckpoint(state.id, "conv-restore", initial!.id);
      assert.equal(restored.message, `Restore checkpoint ${initial!.id.slice(0, 7)}`);
      assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
      assert.equal(existsSync(join(root, "b.txt")), false);
      assert.equal((await runtime.listCheckpoints(state.id)).length, 3);

      // The agent is told about the restore on its next prompt, once.
      const third = fakeTurn({ cellId: state.id, conversation, runId: crypto.randomUUID(), cellEventCursor: 4, userText: "continue" });
      runtime.startTurn(third);
      await waitFor(() => third.finished.length > 0);
      assert.match(state.prompts.at(-1)!.message, /restored the workspace to checkpoint/);
      assert.match(state.prompts.at(-1)!.message, /continue$/);

      await assert.rejects(() => runtime.restoreCheckpoint(state.id, "conv-restore", "not-a-sha"), /invalid_checkpoint/);
      await assert.rejects(() => runtime.restoreCheckpoint(state.id, "conv-restore", "deadbeefdeadbeef"), /checkpoint_not_found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restarts the bridge before prompting a cell that was paused while idle", async () => {
    const cells = new Map<string, FakeCellState>();
    const runtime = new AsterHotcellRuntime(fakeProvider(cells), { archiveWorkspace: async () => "QUJD", pollIntervalMs: 5 });
    const { cellId } = await runtime.provisionConversation({
      conversationId: crypto.randomUUID(), sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {},
    });
    const state = [...cells.values()][0]!;
    // A container-driver pause is a cold stop: the bridge process is gone afterwards.
    for (const proc of state.processes) proc.status = "exited";

    const turn = fakeTurn({ cellId });
    runtime.startTurn(turn);
    await waitFor(() => turn.finished.length > 0);
    assert.equal(state.processes.filter((proc) => proc.status === "running").length, 1);
    assert.deepEqual(turn.finished, ["completed"]);
  });

  it("clones code projects through the GitHub gateway and leaves chat cells unseeded", async () => {
    const cells = new Map<string, FakeCellState>();
    let archived = 0;
    const runtime = new AsterHotcellRuntime(fakeProvider(cells), { archiveWorkspace: async () => { archived++; return "QUJD"; } });
    const base = { sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo", model: "test/model", allowCreate: true, onCellCreated: () => {} };

    await runtime.provisionConversation({ ...base, conversationId: crypto.randomUUID(), project: { kind: "code", repository: "me/app", baseBranch: "main", branch: "aster/abcd1234" } });
    const codeCell = [...cells.values()].at(-1)!;
    const clone = codeCell.commands!.find((command) => command.includes("github-git/me/app.git"))!;
    assert.match(clone, /\$\{GITHUB_BASE_URL%\/github\}\/github-git\/me\/app\.git/);
    assert.match(clone, /git checkout -q -b 'aster\/abcd1234' FETCH_HEAD/);
    assert.doesNotMatch(clone, /github_pat_|ghp_/);
    assert.ok(codeCell.commands!.some((command) => command.includes("artifacts/")), "code cells exclude artifacts/ from git");
    assert.match(codeCell.files.get("/workspace/.aster/pending-notes") ?? "", /me\/app is cloned at \/workspace on branch aster\/abcd1234/);

    await runtime.provisionConversation({ ...base, conversationId: crypto.randomUUID(), project: { kind: "chat" } });
    const chatCell = [...cells.values()].at(-1)!;
    assert.ok(!chatCell.commands!.some((command) => command.includes("github-git")));
    assert.match(chatCell.files.get("/workspace/.aster/pending-notes") ?? "", /\/workspace\/artifacts\//);
    assert.equal(archived, 0, "chat and code cells don't receive the configured workspace");

    await assert.rejects(
      () => runtime.provisionConversation({ ...base, conversationId: crypto.randomUUID(), project: { kind: "code", repository: "me/app; rm -rf /", baseBranch: "main", branch: "aster/x" } }),
      /invalid_project/,
    );
  });

  it("only reads artifacts by safe relative paths", async () => {
    const cells = new Map<string, FakeCellState>();
    const runtime = new AsterHotcellRuntime(fakeProvider(cells), { archiveWorkspace: async () => "QUJD" });
    const { cellId } = await runtime.provisionConversation({
      conversationId: crypto.randomUUID(), sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {}, project: { kind: "chat" },
    });
    for (const path of ["../etc/passwd", "/etc/passwd", ".git/config", "a/../../b", "", "x\ny"]) {
      await assert.rejects(() => runtime.readArtifact(cellId, path), /invalid_artifact_path/, path);
    }
  });

  it("pauses idle cells least recently used first, never mid-turn, and makes room when creation fails", async () => {
    const now = Date.now();
    const cells = [
      { id: "old", conversationId: "a", status: "running", lastActivityAt: new Date(now - 3_600_000).toISOString() },
      { id: "older", conversationId: "b", status: "running", lastActivityAt: new Date(now - 7_200_000).toISOString() },
      { id: "fresh", conversationId: "c", status: "running", lastActivityAt: new Date(now - 1_000).toISOString() },
      { id: "asleep", conversationId: "d", status: "paused", lastActivityAt: new Date(now - 9_000_000).toISOString() },
    ];
    const paused: string[] = [];
    let creates = 0;
    const provider = {
      listConversationCells: async () => cells.filter((cell) => !paused.includes(cell.id)),
      pauseConversationCell: async (id: string) => { paused.push(id); },
      findConversationCell: async () => undefined,
      createConversationCell: async () => {
        creates++;
        if (creates === 1) throw new Error("capacity");
        const state = emptyCellState("new-cell");
        state.processes = [];
        return fakeSandbox(state);
      },
      getCell: async () => { throw new Error("unused"); },
    } as unknown as HotcellProvider;
    const runtime = new AsterHotcellRuntime(provider, { archiveWorkspace: async () => "QUJD" });

    assert.deepEqual(await runtime.pauseIdleCells(15 * 60_000, 1), ["older"]);
    assert.deepEqual(await runtime.pauseIdleCells(15 * 60_000), ["old"]);
    assert.deepEqual(await runtime.pauseIdleCells(15 * 60_000), [], "fresh and already-paused cells stay as they are");

    // Out of capacity on create: pause the least recently used idle cell, then retry once.
    cells.push({ id: "idle-two-hours", conversationId: "e", status: "running", lastActivityAt: new Date(now - 7_200_000).toISOString() });
    await runtime.provisionConversation({
      conversationId: crypto.randomUUID(), sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {}, project: { kind: "chat" },
    });
    assert.equal(creates, 2);
    assert.equal(paused.at(-1), "idle-two-hours");
  });

  it("re-attaches to a turn after a server restart without re-sending the prompt", async () => {
    const cells = new Map<string, FakeCellState>();
    const runtime = new AsterHotcellRuntime(fakeProvider(cells), { archiveWorkspace: async () => "QUJD", pollIntervalMs: 5 });
    const { cellId } = await runtime.provisionConversation({
      conversationId: crypto.randomUUID(), sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {}, project: { kind: "chat" },
    });
    const state = [...cells.values()][0]!;
    // The cell kept working while the server was down; its journal has the rest of the turn.
    state.events.push(
      { cursor: 1, runId: "r", event: { type: "message.delta", text: "already said" } },
      { cursor: 2, runId: "r", event: { type: "message.delta", text: " and finished" } },
      { cursor: 3, runId: "r", event: { type: "session.end", reason: "complete" } },
    );
    const turn = fakeTurn({ cellId, cellEventCursor: 1 });
    runtime.resumeTurn(turn);
    await waitFor(() => turn.finished.length > 0);
    assert.deepEqual(turn.finished, ["completed"]);
    assert.deepEqual(state.prompts, [], "no prompt is re-sent");
    assert.deepEqual(turn.events.filter((e) => e.type === "assistant.delta").map((e) => e.data?.text), [" and finished"], "resumes after the saved cursor");
  });

  it("ends a turn the cell no longer runs instead of leaving the chat busy", async () => {
    const cells = new Map<string, FakeCellState>();
    const runtime = new AsterHotcellRuntime(fakeProvider(cells), { archiveWorkspace: async () => "QUJD", pollIntervalMs: 1 });
    const { cellId } = await runtime.provisionConversation({
      conversationId: crypto.randomUUID(), sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {}, project: { kind: "chat" },
    });
    const turn = fakeTurn({ cellId, cellEventCursor: 0 });
    runtime.resumeTurn(turn);
    await waitFor(() => turn.finished.length > 0, 60_000);
    assert.deepEqual(turn.finished, ["failed"]);
  });

  it("switches the cell session's model through the bridge", async () => {
    const cells = new Map<string, FakeCellState>();
    const runtime = new AsterHotcellRuntime(fakeProvider(cells), { archiveWorkspace: async () => "QUJD" });
    const { cellId } = await runtime.provisionConversation({
      conversationId: crypto.randomUUID(), sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {},
    });
    await runtime.setModel(cellId, "anthropic/claude-opus-5.5");
    assert.deepEqual([...cells.values()][0]!.modelSwitches, ["anthropic/claude-opus-5.5"]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
