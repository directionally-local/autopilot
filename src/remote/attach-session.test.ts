import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppActions, AppBridge, AppSnapshot } from "../ui/app-bridge.js";
import { attachRemote, checkFlags, remoteHeader, type AttachRemoteFlags, type MountRemoteView } from "./attach-cli.js";
import { laptopImagePaths, REMOTE_COMMANDS, REVOKED_MESSAGE, serverModelEntries } from "./attach-session.js";
import { startAsterStub, type AsterStub } from "./aster-stub.test-support.js";

let stub: AsterStub;
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "attach-remote-"));
  process.env.AUTOPILOT_JOBS_DB = join(dir, "jobs.db");
});

afterEach(async () => {
  await stub?.close();
});

after(() => {
  delete process.env.AUTOPILOT_JOBS_DB;
});

class FakeBridge implements AppBridge {
  actions!: AppActions;
  last: AppSnapshot | null = null;
  snapshots = 0;
  sync(s: AppSnapshot): void {
    this.last = s;
    this.snapshots++;
  }
  connect(a: AppActions): void {
    this.actions = a;
  }
  texts(): string[] {
    return (this.last?.events ?? []).map((e) => `${e.kind}:${"text" in e ? e.text : "message" in e ? e.message : e.kind === "tool" ? `${e.name} ${e.args} ${e.status}` : ""}`);
  }
}

async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Start attach-remote against the stub with a fake view; resolves once the session is mounted. */
async function attach(flags: AttachRemoteFlags, opts: { env?: NodeJS.ProcessEnv; bridge?: AppBridge } = {}) {
  const bridge = (opts.bridge ?? new FakeBridge()) as FakeBridge;
  const errors: string[] = [];
  let mounted: (() => void) | null = null;
  const mountedP = new Promise<void>((r) => (mounted = r));
  let header: Parameters<MountRemoteView>[0]["header"] | null = null;
  let ids = 0;
  const done = attachRemote(flags, {
    env: opts.env ?? { AUTOPILOT_REMOTE_URL: stub.url, AUTOPILOT_REMOTE_TOKEN: stub.token },
    err: (t) => void errors.push(t),
    newId: () => `id-${++ids}`,
    mount: async (m) => {
      header = m.header;
      const p = m.run(bridge);
      mounted!();
      await p;
    },
  });
  await Promise.race([mountedP, done]);
  return { bridge, errors, done, header: () => header };
}

const turnRequests = () => stub.requests.filter((r) => r.method === "POST" && r.path.endsWith("/turns"));

describe("attach-remote: flags", () => {
  it("needs --conversation, or --workspace/--repo/--model", () => {
    assert.equal(checkFlags({ conversation: "abc" }), "reconnect");
    assert.equal(checkFlags({ workspace: "w", repo: "o/r", model: "m" }), "create");
    assert.throws(() => checkFlags({}), /missing: --workspace, --repo, --model/);
    assert.throws(() => checkFlags({ conversation: "a", repo: "o/r" }), /don't combine/);
    assert.throws(() => checkFlags({ workspace: "w", repo: "o/r", model: "m", patchFile: "p" }), /needs --base-commit/);
    assert.throws(() => checkFlags({ workspace: "w", repo: "o/r", model: "m", baseCommit: "abc" }), /40-character/);
  });

  it("refuses to run without the URL and token in the environment", async () => {
    stub = await startAsterStub();
    const { done, errors } = await attach({ conversation: "x" }, { env: { AUTOPILOT_REMOTE_URL: stub.url } });
    assert.equal(await done, 1);
    assert.match(errors.join(""), /AUTOPILOT_REMOTE_TOKEN is not set/);
  });

  it("header uses --title, else the repository", () => {
    const c = { conversationId: "c", workspaceId: "w", model: "m/x", status: "ready", activeRunId: null, lastEventId: 0, createdAt: "", updatedAt: "", repository: "o/r", branch: "aster/c" };
    assert.equal(remoteHeader(c, "dl-test · o/r").title, "dl-test · o/r");
    assert.equal(remoteHeader(c, undefined).title, "autopilot · o/r");
    assert.match(remoteHeader(c, undefined).detail.join("\n"), /m\/x · o\/r · aster\/c · remote session[\s\S]*keeps running on the server/);
  });

  it("picker entries follow the server's IDs: local catalog first, then the server's metadata", () => {
    const entries = serverModelEntries(
      ["moonshotai/kimi-k2.6", "vendor/model-b", "vendor/bare"],
      [{ id: "vendor/model-b", name: "Vendor: Model B", contextWindow: 200_000, inputPerMtok: 1, outputPerMtok: 2, vision: true }],
    );
    assert.deepEqual(entries.map((m) => m.id), ["moonshotai/kimi-k2.6", "vendor/model-b", "vendor/bare"]);
    assert.equal(entries[0]!.name, "MoonshotAI: Kimi K2.6");
    assert.equal(entries[1]!.name, "Vendor: Model B");
    assert.equal(entries[1]!.contextWindow, 200_000);
    assert.deepEqual(entries[1]!.pricing, { inputPerMtok: 1, outputPerMtok: 2 });
    assert.equal(entries[1]!.supports.vision, true);
    assert.equal(entries[2]!.supports.tools, true);
  });

  it("only absolute or ~ image paths count as laptop attachments", () => {
    assert.deepEqual(laptopImagePaths("look at /Users/me/shot.png and docs/logo.png"), ["/Users/me/shot.png"]);
    assert.deepEqual(laptopImagePaths("see '~/Desktop/a b.jpg'"), []);
    assert.deepEqual(laptopImagePaths("see ~/Desktop/a.JPG"), ["~/Desktop/a.JPG"]);
  });
});

describe("attach-remote: session against a stub Aster server", () => {
  it("creates a code conversation (Idempotency-Key, base commit, patch), writes the state file, runs a turn and shows the PR", async () => {
    stub = await startAsterStub();
    const patchFile = join(dir, "local.patch");
    await writeFile(patchFile, "diff --git a/x b/x\n");
    const stateFile = join(dir, "nested", "state.json");
    const sha = "a".repeat(40);
    const { bridge, done, errors, header } = await attach({ workspace: "default", repo: "acme/project", model: "vendor/model-a", baseCommit: sha, patchFile, stateFile, title: "dl-test · acme/project" });

    const create = stub.requests.find((r) => r.method === "POST" && r.path === "/api/v1/conversations")!;
    assert.equal(create.idempotencyKey, "attach-id-1");
    assert.deepEqual(create.body, { workspaceId: "default", model: "vendor/model-a", repository: "acme/project", baseCommit: sha, patch: "diff --git a/x b/x\n", kind: "code" });
    assert.equal(header()?.title, "dl-test · acme/project");

    const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, string>;
    const [id] = [...stub.conversations.keys()];
    assert.deepEqual(state, { conversationId: id, branch: `aster/${id!.slice(0, 8)}`, repository: "acme/project" });
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);

    await waitFor(() => !!bridge.last && !bridge.last.turnRunning, "caught up");
    bridge.actions.submit("fix the flaky test");
    await waitFor(() => bridge.texts().some((t) => t.includes("Pull request: https://github.com/acme/project/pull/7")), "PR notice");
    const turns = turnRequests();
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]!.body, { clientTurnId: "attach-id-2", text: "fix the flaky test" });
    const s = bridge.last!;
    assert.equal(s.turnRunning, false);
    assert.deepEqual(s.tasks.map((t) => t.status), ["completed", "in_progress"]);
    assert.equal(s.sessionUsage?.cost, 0.0123);
    assert.ok(bridge.texts().includes("tool:bash npm test done"));
    assert.ok(bridge.texts().some((t) => t === "assistant:Working on: fix the flaky test. "));

    bridge.actions.exit();
    assert.equal(await done, 0);
    assert.match(errors.join(""), /Detached from conversation .*keeps running on the server/);
    assert.ok(!errors.join("").includes("diff --git"), "the patch is never logged");
  });

  it("reconnect replays history from event 0, then follows live; the PR is shown once", async () => {
    stub = await startAsterStub();
    stub.seed({ conversationId: "11111111-aaaa", pullRequestURL: "https://github.com/acme/project/pull/3" }, [
      { type: "conversation.created", data: {} },
      { type: "assistant.delta", data: { text: "Earlier answer." } },
      { type: "usage", data: { inputTokens: 10, outputTokens: 1, costUsd: 0.5, cumulative: true } },
      { type: "completed", data: {} },
    ]);
    const stateFile = join(dir, "reconnect.json");
    const { bridge, done } = await attach({ conversation: "11111111-aaaa", stateFile });
    await waitFor(() => bridge.texts().includes("assistant:Earlier answer.") && bridge.texts().some((t) => t.includes("pull/3")), "replay");
    assert.equal(stub.requests.find((r) => r.path.endsWith("/events"))?.lastEventId, "0");
    assert.match(bridge.texts()[0]!, /Reconnected to conversation 11111111/);
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).conversationId, "11111111-aaaa");
    assert.equal(turnRequests().length, 0, "reconnecting sends nothing");
    // A live turn: the PR URL is unchanged, so it isn't repeated.
    bridge.actions.submit("next");
    await waitFor(() => stub.conversations.get("11111111-aaaa")!.activeRunId === null && turnRequests().length === 1 && bridge.last?.turnRunning === false, "live turn");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.texts().filter((t) => t.includes("pull/3")).length, 1);
    assert.ok(Math.abs((bridge.last!.sessionUsage?.cost ?? 0) - 0.5123) < 1e-9, "cost includes the replayed history");
    // A changed PR is shown again.
    stub.conversations.get("11111111-aaaa")!.pullRequestURL = "https://github.com/acme/project/pull/4";
    bridge.actions.submit("again");
    await waitFor(() => bridge.texts().some((t) => t.includes("Pull request changed: https://github.com/acme/project/pull/4")), "changed PR");
    bridge.actions.exit();
    assert.equal(await done, 0);
  });

  it("messages typed during a turn queue and go one turn at a time", async () => {
    stub = await startAsterStub();
    stub.holdTerminal = true;
    const { bridge, done } = await attach({ workspace: "default", repo: "acme/project", model: "vendor/model-a" });
    await waitFor(() => bridge.last?.turnRunning === false, "ready");
    bridge.actions.submit("first");
    await waitFor(() => bridge.last?.turnRunning === true, "running");
    bridge.actions.submit("second");
    await waitFor(() => bridge.last!.events.some((e) => e.kind === "user" && e.text === "second" && e.queued === true), "queued");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(turnRequests().length, 1);
    stub.release();
    await waitFor(() => turnRequests().length === 2, "second turn");
    assert.equal(turnRequests()[1]!.body?.text, "second");
    assert.notEqual(turnRequests()[0]!.body?.clientTurnId, turnRequests()[1]!.body?.clientTurnId);
    assert.ok(bridge.last!.events.some((e) => e.kind === "user" && e.text === "second" && !e.queued));
    stub.release();
    bridge.actions.exit();
    assert.equal(await done, 0);
  });

  it("Esc cancels the running turn on the server; quitting only detaches", async () => {
    stub = await startAsterStub();
    stub.holdTerminal = true;
    const { bridge, done } = await attach({ workspace: "default", repo: "acme/project", model: "vendor/model-a" });
    await waitFor(() => bridge.last?.turnRunning === false, "ready");
    bridge.actions.submit("long task");
    await waitFor(() => bridge.last?.turnRunning === true, "running");
    bridge.actions.interrupt();
    await waitFor(() => bridge.texts().includes("info:Turn cancelled."), "cancelled");
    assert.equal(stub.requests.filter((r) => r.path.endsWith("/cancel")).length, 1);
    assert.equal(bridge.last!.turnRunning, false);

    bridge.actions.submit("another long task");
    const [id] = [...stub.conversations.keys()];
    await waitFor(() => stub.conversations.get(id!)!.activeRunId !== null, "second running");
    bridge.actions.submit("/exit");
    assert.equal(await done, 0);
    assert.equal(stub.requests.filter((r) => r.path.endsWith("/cancel")).length, 1, "detaching doesn't cancel");
    assert.notEqual(stub.conversations.get(id!)!.activeRunId, null, "the turn keeps running on the server");
  });

  it("401 at startup: exits 1 with the revoked-credential message", async () => {
    stub = await startAsterStub();
    stub.seed({ conversationId: "22222222" });
    stub.revoked = true;
    const { done, errors } = await attach({ conversation: "22222222" });
    assert.equal(await done, 1);
    assert.match(errors.join(""), /credential was revoked or expired/);
  });

  it("401 mid-session ends the session with exit 1", async () => {
    stub = await startAsterStub();
    stub.seed({ conversationId: "33333333" }, [{ type: "completed", data: {} }]);
    const { bridge, done, errors } = await attach({ conversation: "33333333" });
    await waitFor(() => bridge.last?.turnRunning === false, "ready");
    stub.revoked = true; // the stream closes; its reconnect is refused
    assert.equal(await done, 1);
    assert.ok(errors.join("").includes(REVOKED_MESSAGE));
  });

  it("an unknown conversation exits 1", async () => {
    stub = await startAsterStub();
    const { done, errors } = await attach({ conversation: "nope" });
    assert.equal(await done, 1);
    assert.match(errors.join(""), /no such conversation/);
  });

  it("SSE drops resume with Last-Event-ID and duplicates are dropped", async () => {
    stub = await startAsterStub();
    stub.dropAfter = 2;
    stub.resendOnConnect = true;
    const { bridge, done } = await attach({ workspace: "default", repo: "acme/project", model: "vendor/model-a" });
    await waitFor(() => bridge.last?.turnRunning === false, "ready");
    bridge.actions.submit("go");
    await waitFor(() => bridge.texts().some((t) => t.includes("Pull request:")), "turn end");
    const resumes = stub.requests.filter((r) => r.path.endsWith("/events")).map((r) => Number(r.lastEventId));
    assert.ok(resumes.length >= 3, `reconnected (${resumes.join(",")})`);
    assert.ok(resumes.slice(1).every((n) => n > 0), "each reconnect resumes after the last event");
    const assistant = bridge.last!.events.filter((e) => e.kind === "assistant").map((e) => (e.kind === "assistant" ? e.text : ""));
    assert.deepEqual(assistant, ["Working on: go. ", "All tests pass."]);
    assert.equal(bridge.last!.events.filter((e) => e.kind === "tool").length, 1);
    bridge.actions.exit();
    assert.equal(await done, 0);
  });

  it("/model switches the next turn's model; local-only commands and inputs are refused", async () => {
    stub = await startAsterStub();
    const { bridge, done } = await attach({ workspace: "default", repo: "acme/project", model: "vendor/model-a" });
    await waitFor(() => bridge.last?.turnRunning === false, "ready");
    bridge.actions.submit("/model vendor/nope");
    await waitFor(() => bridge.texts().some((t) => t.includes("doesn't offer vendor/nope")), "unknown model");
    bridge.actions.submit("/model vendor/model-b");
    await waitFor(() => bridge.last?.model === "vendor/model-b", "next model shown");
    bridge.actions.submit("!ls");
    bridge.actions.submit("/mcp list");
    bridge.actions.submit("/frobnicate");
    bridge.actions.submit("what's in /Users/me/Desktop/shot.png?");
    await waitFor(() => bridge.texts().filter((t) => t.startsWith("info:")).length >= 7, "refusals");
    const texts = bridge.texts().join("\n");
    assert.match(texts, /Shell commands \(!\) run on this laptop/);
    assert.match(texts, /\/mcp works on this laptop's session, so it's off in a remote session/);
    assert.match(texts, /Unknown command \/frobnicate/);
    assert.match(texts, /Not sent: \/Users\/me\/Desktop\/shot\.png is a file on this laptop/);
    assert.equal(turnRequests().length, 0);
    bridge.actions.submit("use the new model");
    await waitFor(() => turnRequests().length === 1, "turn");
    assert.equal(turnRequests()[0]!.body?.model, "vendor/model-b");
    await waitFor(() => bridge.last?.turnRunning === false, "turn done");
    bridge.actions.submit("and again");
    await waitFor(() => turnRequests().length === 2, "turn 2");
    assert.equal(turnRequests()[1]!.body?.model, undefined, "the model is sent once, when it changes");
    bridge.actions.submit("/status");
    await waitFor(() => bridge.texts().some((t) => t.includes("Model         vendor/model-b")), "status");
    bridge.actions.exit();
    assert.equal(await done, 0);
  });

  it("/model with no ID opens the picker on the server's models; a pick switches the next turn, Esc changes nothing", async () => {
    stub = await startAsterStub();
    stub.modelCatalog = [{ id: "vendor/model-b", name: "Vendor: Model B", contextWindow: 200_000, inputPerMtok: 1, outputPerMtok: 2 }];
    const { bridge, done } = await attach({ workspace: "default", repo: "acme/project", model: "vendor/model-a" });
    await waitFor(() => bridge.last?.turnRunning === false, "ready");
    assert.deepEqual(bridge.last!.modals, []);

    bridge.actions.submit("/model");
    await waitFor(() => bridge.last?.modals.includes("model") === true, "picker open");
    const choices = bridge.last!.modelChoices!;
    assert.deepEqual(choices.map((m) => m.id), ["vendor/model-a", "vendor/model-b"], "only the server's models");
    assert.equal(choices[1]!.name, "Vendor: Model B");

    // Esc
    bridge.actions.pickModel(null);
    await waitFor(() => bridge.last?.modals.length === 0, "picker closed");
    assert.equal(bridge.last!.modelChoices, undefined);
    assert.equal(bridge.last!.model, "vendor/model-a");
    assert.ok(!bridge.texts().some((t) => t.includes("The next turn uses")));

    bridge.actions.submit("/model");
    await waitFor(() => bridge.last?.modals.includes("model") === true, "picker open again");
    bridge.actions.pickModel(bridge.last!.modelChoices![1]!);
    await waitFor(() => bridge.last?.model === "vendor/model-b" && bridge.last.modals.length === 0, "next model shown");
    assert.ok(bridge.texts().includes("info:The next turn uses vendor/model-b."));
    bridge.actions.submit("use the picked model");
    await waitFor(() => turnRequests().length === 1, "turn");
    assert.equal(turnRequests()[0]!.body?.model, "vendor/model-b");

    bridge.actions.submit("/model list");
    await waitFor(() => bridge.texts().some((t) => t.includes("Offered by the server:")), "list");
    assert.match(bridge.texts().join("\n"), /  vendor\/model-a\n  vendor\/model-b/);
    assert.deepEqual(bridge.last!.modals, []);
    assert.equal(stub.requests.filter((r) => r.path === "/api/v1/models").length, 1, "the server's list is fetched once");
    bridge.actions.exit();
    assert.equal(await done, 0);
  });

  it("/model falls back to the plain message when the server's models can't be fetched", async () => {
    stub = await startAsterStub();
    stub.modelsDown = true;
    const { bridge, done } = await attach({ workspace: "default", repo: "acme/project", model: "vendor/model-a" });
    await waitFor(() => bridge.last?.turnRunning === false, "ready");
    bridge.actions.submit("/model");
    await waitFor(() => bridge.texts().some((t) => t.includes("Switch with /model <id> (the server checks it")), "fallback");
    assert.deepEqual(bridge.last!.modals, []);
    bridge.actions.exit();
    assert.equal(await done, 0);
  });

  it("approval.required opens the permission prompt; the decision is posted", async () => {
    stub = await startAsterStub();
    stub.approvals.set("ap-1", { approvalId: "ap-1", status: "pending", tool: "edit", explanation: "Edit src/a.ts", arguments: { path: "src/a.ts" } });
    stub.script = () => [{ type: "approval.required", data: { approvalId: "ap-1", tool: "edit", explanation: "Edit src/a.ts" } }];
    stub.holdTerminal = true;
    const { bridge, done } = await attach({ workspace: "default", repo: "acme/project", model: "vendor/model-a" });
    await waitFor(() => bridge.last?.turnRunning === false, "ready");
    bridge.actions.submit("edit it");
    await waitFor(() => bridge.last?.permission !== null && bridge.last?.permission !== undefined, "permission");
    const p = bridge.last!.permission!;
    assert.equal(p.tool.name, "edit");
    assert.deepEqual(p.args, { path: "src/a.ts" });
    assert.equal(p.tool.render?.(p.args)?.title, "Edit src/a.ts");
    bridge.actions.decidePermission("allow_session");
    await waitFor(() => stub.approvals.get("ap-1")!.status === "approved", "decision");
    assert.equal(bridge.last!.permission, null);
    stub.release();
    bridge.actions.exit();
    assert.equal(await done, 0);
  });
});

describe("attach-remote through the Camouflage view (headless)", () => {
  it("renders a remote turn with the same renderer events a local turn produces", async () => {
    stub = await startAsterStub();
    const { View } = await import("../camouflage-view.js");
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    const cam = { send: (type: string, payload: Record<string, unknown> = {}) => (sent.push({ type, payload }), true), on() { return this; }, close: async () => 0 };
    const sdk = { permission: async () => ({ choice: "deny" }), selectList: async () => ({ id: "", cancelled: true }), confirm: async () => ({ id: "", cancelled: true }), form: async () => ({ id: "", cancelled: true }) };
    const view = new View(cam as never, sdk as never, { commands: REMOTE_COMMANDS });
    const { done } = await attach({ workspace: "default", repo: "acme/project", model: "vendor/model-a" }, { bridge: view });
    await waitFor(() => !view.busy && sent.some((s) => s.type === "SlashCommandsRegistered"), "mounted");
    // The user typed it in the renderer (which echoes it), then the view submits it.
    view.echoed.push("fix the flaky test");
    view.actions!.submit("fix the flaky test");
    await waitFor(() => sent.some((s) => s.type === "RuntimeError" && String(s.payload.message).includes("pull/7")), "PR notice");
    const types = sent.map((s) => s.type);
    for (const t of ["AssistantStreamStarted", "AssistantTokenDelta", "AssistantMessageCompleted", "ToolExecutionStarted", "ToolExecutionFinished", "TodoListUpdate", "StatusUpdate"]) {
      assert.ok(types.includes(t), `sends ${t}`);
    }
    const commands = sent.find((s) => s.type === "SlashCommandsRegistered")!.payload.commands as { name: string }[];
    assert.deepEqual(commands.map((c) => c.name), ["help", "model", "status", "pr", "exit"]);
    const started = sent.find((s) => s.type === "ToolExecutionStarted")!.payload;
    assert.equal(started.tool, "Bash");
    assert.equal(started.command, "npm test");
    const finished = sent.find((s) => s.type === "ToolExecutionFinished")!.payload;
    assert.equal(finished.status, "done");
    assert.equal(finished.output, "ok\n2 passing");
    assert.ok(!types.includes("UserMessageCreated"), "the echoed prompt isn't printed twice");
    const status = Object.assign({}, ...sent.filter((s) => s.type === "StatusUpdate").map((s) => s.payload.segments)) as Record<string, string>;
    assert.equal(status.cost, "$0.01");
    assert.equal(status.model, "model-a");
    assert.equal(status.phase, "idle");
    const todos = sent.filter((s) => s.type === "TodoListUpdate").at(-1)!.payload.todos as { title: string; status: string }[];
    assert.deepEqual(todos.map((t) => `${t.title}:${t.status}`), ["Run tests:completed", "Open PR:in_progress"]);
    view.actions!.exit();
    assert.equal(await done, 0);
    view.dispose();
  });

  it("/model opens the renderer's model picker with only the server's models", async () => {
    stub = await startAsterStub();
    const { View } = await import("../camouflage-view.js");
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    const cam = { send: (type: string, payload: Record<string, unknown> = {}) => (sent.push({ type, payload }), true), on() { return this; }, close: async () => 0 };
    const lists: { prompt: string; options: { value: string }[] }[] = [];
    let answer: { value?: string; cancelled: boolean } = { cancelled: true };
    const sdk = {
      permission: async () => ({ choice: "deny" }),
      selectList: async (_cam: unknown, req: { prompt: string; options: { value: string }[] }) => (lists.push(req), { id: "", ...answer }),
      confirm: async () => ({ id: "", cancelled: true }),
      form: async () => ({ id: "", cancelled: true }),
    };
    const view = new View(cam as never, sdk as never, { commands: REMOTE_COMMANDS });
    const { done } = await attach({ workspace: "default", repo: "acme/project", model: "vendor/model-a" }, { bridge: view });
    await waitFor(() => !view.busy && sent.some((s) => s.type === "SlashCommandsRegistered"), "mounted");

    view.actions!.submit("/model");
    await waitFor(() => lists.length === 1, "picker");
    assert.equal(lists[0]!.prompt, "Select a model");
    assert.deepEqual(lists[0]!.options.map((o) => o.value).sort(), ["vendor/model-a", "vendor/model-b"]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lists.length, 1, "Esc doesn't reopen it");

    answer = { value: "vendor/model-b", cancelled: false };
    view.actions!.submit("/model");
    await waitFor(() => sent.some((s) => s.type === "RuntimeError" && String(s.payload.message).includes("The next turn uses vendor/model-b.")), "switched");
    assert.equal(lists.length, 2);
    view.actions!.exit();
    assert.equal(await done, 0);
    view.dispose();
  });
});
