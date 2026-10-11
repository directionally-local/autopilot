import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { Sandbox } from "@hotcell/sdk";
import { getAppVersion } from "../util/version.js";
import type { AsterApiRuntime, AsterTurnStart } from "./aster-api.js";
import type { HotcellProvider } from "./hotcell-provider.js";
import { redactLikelySecrets } from "./aster-tools.js";

const execFileAsync = promisify(execFile);

const CELL_WORKSPACE = "/workspace";
const CELL_STATE_DIR = "/workspace/.aster";
const CHECKPOINT_MESSAGE_FILE = `${CELL_STATE_DIR}/checkpoint-message`;
const CELL_RUNTIME_DIR = "/opt/autopilot/node_modules/autopilot-ai";
const INSTALLED_RUNTIME_PACKAGE = `${CELL_RUNTIME_DIR}/package.json`;
const CELL_RUNTIME_SDK_ENTRY = `${CELL_RUNTIME_DIR}/dist/sdk/index.js`;
const NOTES_FILE = `${CELL_STATE_DIR}/pending-notes`;
const MEMORY_FILE = `${CELL_STATE_DIR}/memory.md`;
const MEMORY_EXTRACTION_TIMEOUT_MS = 15_000;
const LIVENESS_CHECK_MS = 20_000;
const ARTIFACTS_DIR = `${CELL_WORKSPACE}/artifacts`;
const MAX_ARTIFACTS = 500;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const REPOSITORY_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
// Fixed identity and no signing so commits never depend on cell-local git config.
const GIT = `git -C ${CELL_WORKSPACE} -c user.name=Autopilot -c user.email=autopilot@aster.invalid -c commit.gpgsign=false`;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const MAX_TOOL_OUTPUT_CHARS = 16_000;
const MAX_TOOL_INPUT_CHARS = 2_000;
const MAX_CHECKPOINTS = 100;
const CELL_CONTROL_DIR = `${CELL_STATE_DIR}/control`;
const BRIDGE_MARKER = "startAsterCellBridge";
const CONTROL_RUNNER =
  `node --input-type=module -e ` +
  `'import { executeAsterCellControl } from "/opt/autopilot/node_modules/autopilot-ai/dist/sdk/index.js";` +
  `const r = await executeAsterCellControl(process.argv[1]);` +
  `process.stdout.write(JSON.stringify(r) + "\\n");'`;
const BRIDGE_RUNNER =
  `node --input-type=module -e ` +
  `'import { startAsterCellBridge } from "/opt/autopilot/node_modules/autopilot-ai/dist/sdk/index.js"; void startAsterCellBridge()'`;

const HEALTH_TIMEOUT_MS = 30_000;
const EVENT_POLL_MS = 400;

export interface AsterHotcellRuntimeOptions {
  /** npm spec installed inside the cell; defaults to the currently running server version. */
  autopilotPackageSpec?: string;
  /** Injected for tests: current server's bundled cell SDK. */
  cellRuntimeSdkBundle?: string;
  /** Injected for tests: archive a workspace Git tree as base64 tar. */
  archiveWorkspace?: (workspaceRoot: string) => Promise<string>;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  /**
   * Pause cells idle (no turn, no API activity) this long, releasing CPU and memory.
   * Hotcell's own idle reaper skips cells with a live background process unless it can
   * snapshot memory, and every Aster cell runs the bridge, so on the container driver
   * nothing was ever paused. Cold-pausing is safe here: the bridge is restarted and its
   * session restored on the next request. 0 disables.
   */
  idlePauseMs?: number;
  /** How often to look for idle cells. */
  idleSweepIntervalMs?: number;
}

export interface AsterCellProject {
  kind: "chat" | "code";
  /** owner/name, for code cells. */
  repository?: string;
  /** Branch to start from (the repository's default branch). */
  baseBranch?: string;
  /** Working branch created for this conversation. */
  branch?: string;
  /** Aster's repository-scoped GitHub proxy (preferred over Hotcell's GitHub gateway). */
  github?: { token: string; gitUrl: string; apiUrl: string };
}

export interface AsterArtifact {
  /** Path relative to /workspace/artifacts. */
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  mimeType: string;
}

export interface AsterCheckpoint {
  id: string;
  message: string;
  createdAt: string;
}

/**
 * AsterApiRuntime backed by one Hotcell per conversation. The provider credentials
 * never enter the cell: model egress goes through Hotcell's OpenRouter credential
 * gateway, scoped to the conversation's model. Only structured SDK events and
 * bounded control payloads leave the cell; prompts and file contents never appear
 * in exec commands or Hotcell logs.
 */
export class AsterHotcellRuntime implements AsterApiRuntime {
  private readonly packageSpec: string;
  private readonly cellRuntimeSdkBundle: string | undefined;
  private readonly archiveWorkspace: (workspaceRoot: string) => Promise<string>;
  private readonly pollIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly activeRuns = new Map<string, { cellId: string; stop: () => void }>();

  constructor(
    private readonly provider: HotcellProvider,
    options: AsterHotcellRuntimeOptions = {},
  ) {
    this.packageSpec = options.autopilotPackageSpec ?? `autopilot-ai@${getAppVersion()}`;
    this.cellRuntimeSdkBundle = options.cellRuntimeSdkBundle;
    this.archiveWorkspace = options.archiveWorkspace ?? defaultArchiveWorkspace;
    this.pollIntervalMs = options.pollIntervalMs ?? EVENT_POLL_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    this.idlePauseMs = options.idlePauseMs ?? 0;
    if (this.idlePauseMs > 0) {
      const timer = setInterval(() => { void this.pauseIdleCells(this.idlePauseMs).catch(() => {}); }, options.idleSweepIntervalMs ?? 60_000);
      timer.unref();
    }
  }

  private readonly idlePauseMs: number;

  /**
   * Pause running cells that have no active turn and no API activity within `idleMs`,
   * least recently used first, stopping after `limit` pauses. Returns the paused ids.
   */
  async pauseIdleCells(idleMs: number, limit = Infinity): Promise<string[]> {
    const busy = new Set([...this.activeRuns.values()].map((run) => run.cellId));
    const now = Date.now();
    const candidates = (await this.provider.listConversationCells())
      .filter((cell) => cell.status === "running" && !busy.has(cell.id) && now - Date.parse(cell.lastActivityAt) >= idleMs)
      .sort((a, b) => Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt));
    const paused: string[] = [];
    for (const cell of candidates) {
      if (paused.length >= limit) break;
      try {
        await this.provider.pauseConversationCell(cell.id);
        paused.push(cell.id);
      } catch { /* a cell that can't pause now is retried on the next sweep */ }
    }
    return paused;
  }

  async provisionConversation(input: {
    conversationId: string;
    sessionId: string;
    cellName: string;
    workspaceId: string;
    workspaceRoot: string;
    model: string;
    allowCreate: boolean;
    onCellCreated: (cellId: string) => void;
    /** Absent: seed the configured workspace (original behavior). */
    project?: AsterCellProject;
  }): Promise<{ cellId: string }> {
    let cell = await this.provider.findConversationCell(input.conversationId);
    if (!cell) {
      if (!input.allowCreate) throw new Error("hotcell_create_uncertain");
      const create = () => this.provider.createConversationCell({
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        model: input.model,
        ...(input.project ? { kind: input.project.kind } : {}),
        ...(input.project?.github ? {
          githubViaProxy: true,
          env: {
            ASTER_GITHUB_TOKEN: input.project.github.token,
            ASTER_GITHUB_GIT_URL: input.project.github.gitUrl,
            ASTER_GITHUB_API_URL: input.project.github.apiUrl,
          },
        } : {}),
      });
      try {
        cell = await create();
      } catch (error) {
        // Likely out of capacity: make room by pausing the least recently used idle cell
        // (its files persist; it wakes on its next message), then try once more.
        if ((await this.pauseIdleCells(60_000, 1).catch(() => [])).length === 0) throw error;
        cell = await create();
      }
    }
    input.onCellCreated(cell.getInfo().id);

    if (input.project?.kind === "code") {
      await this.cloneRepository(cell, input.project);
    } else if (input.project?.kind !== "chat") {
      await this.seedWorkspace(cell, input.workspaceRoot);
    }
    await this.ensureRepository(cell, input.project?.kind === "code");
    if (input.project) await this.addNote(cell, projectNote(input.project));
    await this.installRuntime(cell);
    await this.ensureBridge(cell);
    await this.control(cell, "POST", "/rpc", {
      id: randomUUID(),
      type: "new_session",
      sessionId: input.sessionId,
      config: { model: input.model, cwd: CELL_WORKSPACE },
    });
    return { cellId: cell.getInfo().id };
  }

  async destroyCell(cellId: string): Promise<void> {
    await this.provider.destroyConversationCell(cellId);
  }

  async pauseCell(cellId: string): Promise<void> {
    await this.provider.pauseConversationCell(cellId);
  }

  async resumeCell(cellId: string): Promise<void> {
    await this.provider.resumeConversationCell(cellId);
  }

  /** Switch the cell session's model between turns. The bridge persists it for session restore. */
  async setModel(cellId: string, model: string): Promise<void> {
    await this.ensureReady(cellId);
    await this.controlById(cellId, "POST", "/rpc", { id: randomUUID(), type: "set_model", modelId: model });
  }

  /** Reinstall the runtime if the cell's image lost it and restart the bridge if it isn't running. */
  private async ensureReady(cellId: string): Promise<void> {
    const cell = await this.provider.getCell(cellId);
    await this.installRuntime(cell);
    await this.ensureBridge(cell);
  }

  /** Newest-first git history of the cell workspace; one commit per completed turn. */
  async listCheckpoints(cellId: string): Promise<AsterCheckpoint[]> {
    const cell = await this.provider.getCell(cellId);
    if (!(await this.ensureRepository(cell))) return [];
    const result = await cell.exec(`${GIT} log -n ${MAX_CHECKPOINTS} --format=%H%x1f%cI%x1f%s`);
    if (result.exitCode !== 0) return [];
    return result.stdout.split("\n").filter(Boolean).map((line) => {
      const [id = "", createdAt = "", message = ""] = line.split("\x1f");
      return { id, createdAt, message };
    });
  }

  /**
   * Make the workspace match a checkpoint, recorded as a new commit so the restore
   * itself can be undone. Ignored files (node_modules, .aster state) are untouched.
   */
  async restoreCheckpoint(cellId: string, conversationId: string, checkpointId: string): Promise<AsterCheckpoint> {
    if (!COMMIT_SHA_RE.test(checkpointId)) throw new Error("invalid_checkpoint");
    const cell = await this.provider.getCell(cellId);
    if (!(await this.ensureRepository(cell))) throw new Error("checkpoints_unavailable");
    const exists = await cell.exec(`${GIT} cat-file -e ${checkpointId}^{commit}`);
    if (exists.exitCode !== 0) throw new Error("checkpoint_not_found");
    const short = checkpointId.slice(0, 7);
    await cell.writeFile(CHECKPOINT_MESSAGE_FILE, `Restore checkpoint ${short}\n`);
    const restore = await cell.exec(
      `${GIT} restore --source=${checkpointId} --staged --worktree -- :/ && ${GIT} clean -fdq && ` +
      `${GIT} commit -q --allow-empty -F ${CHECKPOINT_MESSAGE_FILE}`,
    );
    if (restore.exitCode !== 0) throw new Error("checkpoint_restore_failed");
    void conversationId;
    await this.addNote(
      cell,
      `[The user restored the workspace to checkpoint ${short}. Files changed after that point were reverted; re-read files before relying on earlier observations.]`,
    );
    const [head] = await this.listCheckpoints(cellId);
    if (!head) throw new Error("checkpoint_restore_failed");
    return head;
  }

  startTurn(turn: AsterTurnStart): void {
    void this.runTurn(turn).catch(() => {
      turn.finish("failed", "cell_runtime_error");
    });
  }

  /**
   * Re-attach to a turn that was running when the server restarted. The cell kept working
   * and journaled its events, so this only resumes reading them from the saved cursor.
   */
  resumeTurn(turn: AsterTurnStart): void {
    void this.runTurn(turn, { resume: true }).catch(() => {
      turn.finish("failed", "cell_runtime_error");
    });
  }

  cancelRun(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.stop();
    void this.controlById(active.cellId, "POST", "/rpc", { id: randomUUID(), type: "abort" }).catch(() => {});
  }

  private async runTurn(turn: AsterTurnStart, options: { resume?: boolean } = {}): Promise<void> {
    const { cellId, runId } = turn;
    let cursor = turn.cellEventCursor;
    let stopped = false;
    let finished = false;
    this.activeRuns.set(runId, { cellId, stop: () => { stopped = true; } });

    const finish = (status: "completed" | "failed" | "cancelled", reason?: string) => {
      if (finished) return;
      finished = true;
      stopped = true;
      this.activeRuns.delete(runId);
      turn.finish(status, reason);
    };
    let outcome: { status: "completed" | "failed" | "cancelled"; reason: string } | undefined;

    let artifactsBefore: AsterArtifact[] = [];
    const usageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    try {
      if (options.resume) throw new Error("resume");
      // An idle cell may have been paused (cold-stopped on the container driver):
      // make sure the runtime and bridge are back before prompting.
      await this.ensureReady(cellId);
      const cell = await this.provider.getCell(cellId);
      if (turn.memory) {
        await cell.mkdir(CELL_STATE_DIR, { parents: true });
        await writeCellFileChunked(cell, MEMORY_FILE, turn.memory.snapshot);
      }
      const note = [await this.readNotes(cell), turn.memory?.note ?? ""].filter(Boolean).join("\n\n");
      const message = note ? `${note}\n\n${turn.userText}` : turn.userText;
      artifactsBefore = await this.listArtifacts(cellId).catch(() => []);
      const mode = turn.mode === "plan" ? "plan" : turn.mode === "auto" ? "auto" : "edit";
      await this.controlById(cellId, "POST", "/rpc", { id: runId, type: "prompt", message, options: { mode } });
      if (note) await this.clearNotes(cell);
    } catch (error) {
      if (!(error instanceof Error && error.message === "resume")) {
        finish("failed", "cell_prompt_rejected");
        return;
      }
      artifactsBefore = await this.listArtifacts(cellId).catch(() => []);
    }

    // Liveness: if the cell reports no active run and has produced nothing for a while,
    // the turn was lost (e.g. the cell was stopped mid-turn); end it rather than leave the
    // conversation busy forever.
    let quietPolls = 0;
    const quietLimit = Math.max(5, Math.ceil(LIVENESS_CHECK_MS / this.pollIntervalMs));
    while (!stopped) {
      await sleep(this.pollIntervalMs);
      if (stopped) break;
      let events: Array<{ cursor: number; runId: string | null; event: Record<string, unknown> }>;
      try {
        const page = await this.controlById(cellId, "GET", `/events?after=${cursor}`) as {
          events?: Array<{ cursor: number; runId: string | null; event: Record<string, unknown> }>;
        };
        events = page.events ?? [];
      } catch {
        continue; // transient cell-control failure; keep polling until stopped or finished
      }
      if (events.length === 0) {
        if (++quietPolls >= quietLimit) {
          quietPolls = 0;
          const status = await this.controlById(cellId, "GET", "/status").catch(() => undefined) as { activeRunId?: string | null } | undefined;
          if (status && !status.activeRunId) {
            outcome = { status: "failed", reason: "cell_turn_lost" };
            break;
          }
        }
        continue;
      }
      quietPolls = 0;
      for (const entry of events) {
        cursor = Math.max(cursor, entry.cursor);
        turn.onCellCursor?.(cursor);
        const event = entry.event;
        switch (event.type) {
          case "message.delta":
            if (typeof event.text === "string") turn.publishEvent("assistant.delta", { text: event.text });
            break;
          case "message.reasoning":
            if (typeof event.text === "string") turn.publishEvent("assistant.reasoning", { text: event.text });
            break;
          case "tool.start":
            turn.publishEvent("tool.activity", {
              tool: event.toolName,
              toolCallId: event.toolCallId,
              activity: "started",
              input: summarizeToolInput(event.toolName, event.args),
            });
            break;
          case "tool.result":
            turn.publishEvent("tool.activity", {
              tool: event.toolName,
              toolCallId: event.toolCallId,
              activity: event.isError === true ? "failed" : "completed",
              output: boundedToolText(typeof event.result === "string" ? event.result : "", MAX_TOOL_OUTPUT_CHARS),
            });
            break;
          case "permission.request": {
            // The SDK emits this for actions that require server-side approval in the selected mode.
            const decision = await turn.askPermission({
              tool: { name: event.toolName },
              args: (event.args as Record<string, unknown>) ?? {},
            } as never);
            await this.controlById(cellId, "POST", "/rpc", {
              id: randomUUID(),
              type: "resolve_permission",
              requestId: event.requestId,
              decision,
            }).catch(() => {});
            turn.publishEvent("tool.activity", { tool: event.toolName, activity: decision === "allow" ? "approved" : "rejected" });
            break;
          }
          case "usage": {
            const inputTokens = typeof event.inputTokens === "number" && Number.isFinite(event.inputTokens) && event.inputTokens >= 0
              ? event.inputTokens
              : 0;
            const outputTokens = typeof event.outputTokens === "number" && Number.isFinite(event.outputTokens) && event.outputTokens >= 0
              ? event.outputTokens
              : 0;
            const cost = typeof event.cost === "number" && Number.isFinite(event.cost) && event.cost >= 0
              ? event.cost
              : 0;
            usageTotals.inputTokens += inputTokens;
            usageTotals.outputTokens += outputTokens;
            usageTotals.costUsd += cost;
            turn.publishEvent("usage", { ...usageTotals, cumulative: true });
            break;
          }
          case "tasks.update": {
            const items = Array.isArray(event.tasks)
              ? event.tasks.flatMap((task) => {
                  if (typeof task !== "object" || task === null) return [];
                  const item = task as Record<string, unknown>;
                  if (typeof item.title !== "string") return [];
                  const status = item.status === "completed"
                    ? "done"
                    : item.status === "in_progress"
                      ? "in_progress"
                      : "pending";
                  return [{ title: item.title, status }];
                })
              : [];
            turn.publishEvent("todo.updated", { items });
            break;
          }
          case "session.end":
            outcome = {
              status: event.reason === "aborted" ? "cancelled" : event.reason === "complete" ? "completed" : "failed",
              // Surface the agent's actual error (redacted, bounded) instead of a bare "error".
              reason: event.reason === "error" && typeof event.error === "string" && event.error.trim()
                ? boundedToolText(event.error.trim(), 500)
                : String(event.reason ?? "cell_session_ended"),
            };
            stopped = true;
            break;
          default:
            break;
        }
        if (outcome) break;
      }
    }
    // Files the turn created or changed under artifacts/ are surfaced to the app.
    try {
      const before = new Map(artifactsBefore.map((artifact) => [artifact.path, artifact]));
      for (const artifact of await this.listArtifacts(cellId)) {
        const previous = before.get(artifact.path);
        if (!previous || previous.size !== artifact.size || previous.modifiedAt !== artifact.modifiedAt) {
          turn.publishEvent("artifact.updated", { ...artifact });
        }
      }
    } catch { /* artifacts are best-effort; the turn's result stands */ }
    // Checkpoint whatever the turn left behind (even partial work from a cancel or
    // failure) before reporting the terminal state, so the client can roll back.
    await this.checkpoint(cellId, turn.userText)
      .then((checkpoint) => { if (checkpoint) turn.publishEvent("checkpoint.created", { ...checkpoint }); })
      .catch(() => {});
    if (outcome?.status === "completed" && turn.beforeFinish) {
      await Promise.race([turn.beforeFinish().catch(() => {}), sleep(MEMORY_EXTRACTION_TIMEOUT_MS)]);
    }
    finish(outcome?.status ?? "cancelled", outcome?.reason ?? "cell_turn_stopped");
  }

  private async seedWorkspace(cell: Sandbox, workspaceRoot: string): Promise<void> {
    const seeded = await cell.exec(`test -f ${CELL_STATE_DIR}/.seeded`);
    if (seeded.exitCode === 0) return;
    await cell.mkdir(CELL_STATE_DIR, { parents: true });
    const archive = await this.archiveWorkspace(workspaceRoot);
    await cell.writeFile(`${CELL_STATE_DIR}/workspace.tar.b64`, archive);
    const extract = await cell.exec(`base64 -d ${CELL_STATE_DIR}/workspace.tar.b64 | tar -x -C ${CELL_WORKSPACE}`);
    if (extract.exitCode !== 0) throw new Error("workspace_seed_failed");
    await cell.exec(`rm -f ${CELL_STATE_DIR}/workspace.tar.b64 && touch ${CELL_STATE_DIR}/.seeded`);
  }

  /**
   * Make /workspace a git repository with an initial commit (idempotent), excluding the
   * bridge's private .aster state. Returns false when the cell image has no git, in
   * which case checkpoints are skipped rather than failing the conversation.
   */
  private async ensureRepository(cell: Sandbox, excludeArtifacts = false): Promise<boolean> {
    const result = await cell.exec(
      `command -v git >/dev/null || exit 3; ` +
      `if [ ! -d ${CELL_WORKSPACE}/.git ]; then git init -q ${CELL_WORKSPACE} || exit 1; fi; ` +
      `grep -qx '.aster/' ${CELL_WORKSPACE}/.git/info/exclude 2>/dev/null || printf '.aster/\\n' >> ${CELL_WORKSPACE}/.git/info/exclude; ` +
      // A code cell's artifacts are for the user, not the repository.
      (excludeArtifacts ? `grep -qx 'artifacts/' ${CELL_WORKSPACE}/.git/info/exclude || printf 'artifacts/\\n' >> ${CELL_WORKSPACE}/.git/info/exclude; ` : "") +
      `${GIT} rev-parse -q --verify HEAD >/dev/null || { ${GIT} add -A && ${GIT} commit -q --allow-empty -m 'Workspace created'; }`,
    );
    return result.exitCode === 0;
  }

  /** Commit all workspace changes; returns the new checkpoint, or undefined when nothing changed. */
  private async checkpoint(cellId: string, userText: string): Promise<AsterCheckpoint | undefined> {
    const cell = await this.provider.getCell(cellId);
    if (!(await this.ensureRepository(cell))) return undefined;
    // The prompt goes through a 0600 file, never the exec command line.
    await cell.writeFile(CHECKPOINT_MESSAGE_FILE, checkpointMessage(userText), { mode: "0600" });
    const commit = await cell.exec(
      `${GIT} add -A && if ${GIT} diff --cached --quiet; then exit 4; fi && ${GIT} commit -q -F ${CHECKPOINT_MESSAGE_FILE}`,
    );
    if (commit.exitCode !== 0) return undefined;
    const [head] = await this.listCheckpoints(cellId);
    return head;
  }

  /**
   * Install the Autopilot runtime unless the cell already has the expected version. This
   * checks the installed package itself rather than a marker on the persistent volume:
   * /opt lives in the cell's root filesystem, which a container-driver pause discards,
   * while an image with the runtime baked in skips the install entirely.
   */
  /**
   * Clone a GitHub repository into /workspace on a new working branch, through Hotcell's
   * credential gateway: the remote points at the gateway and git authenticates with the
   * cell's own egress token, so the real GitHub token never enters the cell. Idempotent.
   */
  private async cloneRepository(cell: Sandbox, project: AsterCellProject): Promise<void> {
    const seeded = await cell.exec(`test -f ${CELL_STATE_DIR}/.seeded`);
    if (seeded.exitCode === 0) return;
    const { repository, baseBranch, branch } = project;
    if (!repository || !REPOSITORY_RE.test(repository) || !baseBranch || !BRANCH_RE.test(baseBranch) || !branch || !BRANCH_RE.test(branch)) {
      throw new Error("invalid_project");
    }
    await cell.mkdir(CELL_STATE_DIR, { parents: true });
    const clone = await cell.exec(
      `set -e; cd ${CELL_WORKSPACE}; ` +
      // Prefer Aster's repository-scoped proxy; fall back to Hotcell's GitHub gateway.
      `if [ -n "$ASTER_GITHUB_GIT_URL" ]; then remote="$ASTER_GITHUB_GIT_URL/${repository}.git"; ` +
      `else remote="\${GITHUB_BASE_URL%/github}/github-git/${repository}.git"; fi; ` +
      `git init -q; git remote add origin "$remote" 2>/dev/null || git remote set-url origin "$remote"; ` +
      `git config credential.helper '!f() { echo username=x-access-token; echo "password=\${ASTER_GITHUB_TOKEN:-$GITHUB_API_KEY}"; }; f'; ` +
      `git config user.name "Aster Autopilot"; git config user.email "autopilot@aster.invalid"; ` +
      `if git ls-remote --exit-code --heads origin '${baseBranch}' >/dev/null 2>&1; then ` +
      `git fetch -q origin '${baseBranch}'; git checkout -q -b '${branch}' FETCH_HEAD; ` +
      `else git checkout -q -b '${branch}'; fi; ` +
      `touch ${CELL_STATE_DIR}/.seeded`,
    );
    if (clone.exitCode !== 0) throw new Error("repository_clone_failed");
  }

  /** Files under /workspace/artifacts, the folder the agent saves user-facing deliverables in. */
  async listArtifacts(cellId: string): Promise<AsterArtifact[]> {
    const cell = await this.provider.getCell(cellId);
    const result = await cell.exec(
      `[ -d ${ARTIFACTS_DIR} ] || exit 0; cd ${ARTIFACTS_DIR} && ` +
      `find . -type f ! -path '*/.*' -printf '%P\\t%s\\t%T@\\n' | head -n ${MAX_ARTIFACTS}`,
    );
    if (result.exitCode !== 0) return [];
    return result.stdout.split("\n").filter(Boolean).flatMap((line) => {
      const [path = "", size = "", modified = ""] = line.split("\t");
      if (!isSafeArtifactPath(path)) return [];
      return [{
        path,
        name: path.split("/").pop() ?? path,
        size: Number(size) || 0,
        modifiedAt: new Date(Math.round(Number(modified) * 1000) || Date.now()).toISOString(),
        mimeType: artifactMimeType(path),
      }];
    }).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /** The bytes of one artifact, at most 50 MB. */
  async readArtifact(cellId: string, path: string): Promise<{ data: Buffer; mimeType: string; name: string }> {
    if (!isSafeArtifactPath(path)) throw new Error("invalid_artifact_path");
    const cell = await this.provider.getCell(cellId);
    const file = shellQuote(`${ARTIFACTS_DIR}/${path}`);
    const stat = await cell.exec(`[ -f ${file} ] && [ ! -L ${file} ] && stat -c %s -- ${file}`);
    if (stat.exitCode !== 0) throw new Error("artifact_not_found");
    if (Number(stat.stdout.trim()) > MAX_ARTIFACT_BYTES) throw new Error("artifact_too_large");
    const encoded = await cell.exec(`base64 -w0 -- ${file}`);
    if (encoded.exitCode !== 0) throw new Error("artifact_not_found");
    return { data: Buffer.from(encoded.stdout.trim(), "base64"), mimeType: artifactMimeType(path), name: path.split("/").pop() ?? path };
  }

  /** Notes are prepended to the agent's next prompt once; kept in the cell so they survive restarts. */
  private async addNote(cell: Sandbox, text: string): Promise<void> {
    const existing = await this.readNotes(cell);
    await cell.mkdir(CELL_STATE_DIR, { parents: true });
    await cell.writeFile(NOTES_FILE, existing ? `${existing}\n\n${text}` : text, { mode: "0600" });
  }

  private async readNotes(cell: Sandbox): Promise<string> {
    try {
      return (await cell.readFile(NOTES_FILE)).trim();
    } catch {
      return "";
    }
  }

  private async clearNotes(cell: Sandbox): Promise<void> {
    await cell.exec(`rm -f ${NOTES_FILE}`);
  }

  private async installRuntime(cell: Sandbox): Promise<void> {
    const expectedVersion = /@(\d[^@/]*)$/.exec(this.packageSpec)?.[1];
    let installed: { version?: string; [key: string]: unknown } | undefined;
    try {
      installed = JSON.parse(await cell.readFile(INSTALLED_RUNTIME_PACKAGE)) as typeof installed;
      if (!expectedVersion || installed?.version === expectedVersion) return;
    } catch { /* not installed in this root filesystem */ }

    if (installed && expectedVersion) {
      // Existing cells keep their writable root filesystem across server/image releases.
      // Refresh the self-contained bridge bundle from this server instead of asking npm
      // for a private prerelease that may not exist in the registry.
      const sdkBundle = this.cellRuntimeSdkBundle ?? await readBundledCellSdkBundle();
      await cell.mkdir(`${CELL_RUNTIME_DIR}/dist/sdk`, { parents: true });
      await writeCellFileChunked(cell, CELL_RUNTIME_SDK_ENTRY, sdkBundle);

      // The bridge has already loaded the old bundle into memory. Stop just that idle
      // process; its durable session state remains on disk and ensureBridge restarts it.
      const bridge = (await cell.listProcesses()).find(
        (process) => process.status === "running" && process.command.includes(BRIDGE_MARKER),
      );
      if (bridge) {
        await cell.killProcess(bridge.procId);
        const deadline = Date.now() + 5_000;
        for (;;) {
          const stillRunning = (await cell.listProcesses()).some(
            (process) => process.procId === bridge.procId && process.status === "running",
          );
          if (!stillRunning) break;
          if (Date.now() >= deadline) throw new Error("cell_runtime_restart_failed");
          await sleep(50);
        }
      }

      // Update the version marker only after the bundle is written and the old bridge
      // is stopped. If any operation fails, the next request retries the migration.
      await cell.writeFile(
        INSTALLED_RUNTIME_PACKAGE,
        JSON.stringify({ ...installed, version: expectedVersion }),
        { mode: "0600" },
      );
      return;
    }

    const install = await cell.exec(`mkdir -p /opt/autopilot && npm install --prefix /opt/autopilot --no-audit --no-fund ${this.packageSpec}`);
    if (install.exitCode !== 0) throw new Error("cell_runtime_install_failed");
  }

  private async ensureBridge(cell: Sandbox): Promise<void> {
    const processes = await cell.listProcesses().catch(() => []);
    const running = processes.find((proc) => proc.status === "running" && proc.command.includes(BRIDGE_MARKER));
    if (!running) {
      await cell.mkdir(CELL_CONTROL_DIR, { parents: true });
      await cell.startProcess(BRIDGE_RUNNER, { cwd: "/opt/autopilot", env: { HOME: `${CELL_STATE_DIR}/home` } });
    }
    const deadline = Date.now() + this.healthTimeoutMs;
    for (;;) {
      try {
        const health = await this.control(cell, "GET", "/health") as { ok?: boolean; initialized?: boolean; sessionId?: string | null };
        // A restarted bridge restores its saved session asynchronously; wait for that
        // so the next prompt isn't rejected as session_not_ready.
        if (health.ok === true && (!health.sessionId || health.initialized === true)) return;
      } catch { /* bridge not listening yet */ }
      if (Date.now() > deadline) throw new Error("cell_bridge_unhealthy");
      await sleep(250);
    }
  }

  private async control(cell: Sandbox, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const requestId = randomUUID();
    await cell.mkdir(CELL_CONTROL_DIR, { parents: true });
    await writeCellFileChunked(cell, `${CELL_CONTROL_DIR}/${requestId}.json`, JSON.stringify({ method, path, body }));
    const result = await cell.exec(`${CONTROL_RUNNER} ${requestId}`);
    if (result.exitCode !== 0) throw new Error("cell_control_failed");
    const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as { error?: string };
    if (parsed.error) throw new Error(parsed.error);
    return parsed;
  }

  private async controlById(cellId: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const cell = await this.provider.getCell(cellId);
    return this.control(cell, method, path, body);
  }
}

// Keep control payload writes small: the Hotcell container driver base64-encodes file contents in a shell argument.
const CELL_FILE_WRITE_CHUNK_CHARS = 32 * 1024;

async function writeCellFileChunked(cell: Sandbox, path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") <= CELL_FILE_WRITE_CHUNK_CHARS) {
    await cell.writeFile(path, content, { mode: "0600" });
    return;
  }

  const partsDir = `${path}.parts`;
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const partPaths: string[] = [];
  await cell.mkdir(partsDir, { parents: true });
  try {
    for (let offset = 0, index = 0; offset < encoded.length; offset += CELL_FILE_WRITE_CHUNK_CHARS, index++) {
      const partPath = `${partsDir}/${String(index).padStart(6, "0")}.b64`;
      await cell.writeFile(partPath, encoded.slice(offset, offset + CELL_FILE_WRITE_CHUNK_CHARS), { mode: "0600" });
      partPaths.push(partPath);
    }
    const result = await cell.exec(
      `cat ${partPaths.map(shellQuote).join(" ")} | base64 -d > ${shellQuote(path)} && chmod 600 ${shellQuote(path)}`,
    );
    if (result.exitCode !== 0) throw new Error("cell_control_failed");
  } finally {
    await cell.exec(`rm -rf ${shellQuote(partsDir)}`).catch(() => {});
  }
}

async function readBundledCellSdkBundle(): Promise<string> {
  // In the packed server, index.js and sdk/index.js are siblings under dist/.
  // The parent candidate also supports running the source module directly.
  for (const url of [new URL("./sdk/index.js", import.meta.url), new URL("../sdk/index.js", import.meta.url)]) {
    try {
      return await readFile(url, "utf8");
    } catch { /* try the other package layout */ }
  }
  throw new Error("cell_runtime_bundle_unavailable");
}

async function defaultArchiveWorkspace(workspaceRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, "archive", "--format=tar", "HEAD"], {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
  });
  return Buffer.from(stdout).toString("base64");
}

function projectNote(project: AsterCellProject): string {
  const artifacts =
    "Save anything meant for the user to look at (documents, slides, PDFs, spreadsheets, web pages, images, reports) " +
    "in /workspace/artifacts/. Files there appear in the user's Aster app (an iPhone), where they can preview, download, and share them. " +
    "Unless the user asks for an editable format, deliver visual documents (slides, reports, one-pagers) as PDF: write HTML/CSS " +
    "(one page per slide, e.g. @page { size: 1280px 720px; margin: 0 }) and print it with " +
    "`chromium --headless --no-sandbox --disable-gpu --no-pdf-header-footer --print-to-pdf=/workspace/artifacts/NAME.pdf FILE.html`. " +
    "For editable files use python-pptx, python-docx, or openpyxl; matplotlib is available for charts. " +
    "Keep drafts and source files outside artifacts/ so only finished deliverables appear there.";
  if (project.kind === "chat") {
    return `[Aster chat. /workspace is this conversation's private Linux sandbox with internet access. ${artifacts}]`;
  }
  const { repository, branch, baseBranch } = project;
  return (
    `[Aster code chat. GitHub repository ${repository} is cloned at /workspace on branch ${branch} (from ${baseBranch}). ` +
    "Commit your work and push with `git push -u origin HEAD`; credentials are preconfigured, so never print or write tokens. " +
    "Only this repository is reachable from here. " +
    `To open a pull request: curl -s -X POST "\${ASTER_GITHUB_API_URL:-$GITHUB_BASE_URL}/repos/${repository}/pulls" -H "Authorization: Bearer \${ASTER_GITHUB_TOKEN:-$GITHUB_API_KEY}" ` +
    `-H "Accept: application/vnd.github+json" -d '{"title":"…","head":"${branch}","base":"${baseBranch}","body":"…"}'. ` +
    `${artifacts} The artifacts folder is not committed to the repository.]`
  );
}

/** Relative path inside artifacts/, without traversal, hidden segments, or control characters. */
function isSafeArtifactPath(path: string): boolean {
  if (!path || path.length > 500 || path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ARTIFACT_MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html", htm: "text/html",
  md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  key: "application/vnd.apple.keynote", pages: "application/vnd.apple.pages", numbers: "application/vnd.apple.numbers",
  zip: "application/zip", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg",
};

function artifactMimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ARTIFACT_MIME_TYPES[extension] ?? "application/octet-stream";
}

function checkpointMessage(userText: string): string {
  const firstLine = redactLikelySecrets(userText).split("\n").find((line) => line.trim())?.trim() ?? "Turn";
  const subject = firstLine.length > 72 ? firstLine.slice(0, 71) + "…" : firstLine;
  return `${subject}\n`;
}

/** A short, redacted description of what a tool was asked to do (the shell command, the file path, …). */
function summarizeToolInput(toolName: unknown, args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const preferred = toolName === "bash" ? record.command : record.path ?? record.pattern ?? record.url ?? record.query;
  const text = typeof preferred === "string" ? preferred : JSON.stringify(args ?? {});
  return boundedToolText(text, MAX_TOOL_INPUT_CHARS);
}

/** Redact and bound tool text, keeping the head and tail (where errors usually are). */
function boundedToolText(text: string, limit: number): string {
  const redacted = redactLikelySecrets(text);
  if (redacted.length <= limit) return redacted;
  const half = Math.floor((limit - 40) / 2);
  return `${redacted.slice(0, half)}\n… [${redacted.length - 2 * half} characters omitted] …\n${redacted.slice(-half)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
