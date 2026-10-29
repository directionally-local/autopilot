import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { WorkerFinding, WorkerResultMessage } from "../agent/messages.js";
import { validateModelId } from "../agent/client.js";
import { getAppVersion, PACKAGE_NAME, CLI_NAME } from "../util/version.js";
import { chunkPayload, getRepositorySnapshot, getWorkingTreeArchive } from "./hotcell-snapshot.js";
import { CACHED_WORKER_DIR, ensureWorkerBackup } from "./hotcell-worker-cache.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_PROMPT_CHARS = 40_000;
const DEFAULT_CELL_TIMEOUT_MS = 600_000;
const DEFAULT_SETUP_TIMEOUT_MS = 300_000;
/** The subagent runtime (Autopilot CLI) inside the cell: restored from the
 *  local cache, or installed there when the cache is unavailable. The target
 *  repository's own dependencies and install scripts never run. */
const WORKER_BIN = `${CACHED_WORKER_DIR}/node_modules/.bin/${CLI_NAME}`;
/** npm package specs we accept for the worker runtime (name@version, tags,
 *  scoped names, tarball URLs). Quoted regardless; this rejects obvious junk. */
const PACKAGE_SPEC = /^[\w@./:+~^=<>#-]+$/;
/** Records where the cloned repo is, skipping the runtime directory (its
 *  node_modules may contain .git folders). Shell state does not persist
 *  between execs, so later steps read the recorded path. */
const LOCATE_REPO_ROOT = [
  `GIT_DIR="$(find /workspace -mindepth 2 -maxdepth 5 -path ${CACHED_WORKER_DIR} -prune -o -name .git -print -quit)"`,
  'test -n "$GIT_DIR"',
  'printf "%s" "${GIT_DIR%/.git}" > /tmp/autopilot-repo-root',
];
const READ_REPO_ROOT = ['REPO_ROOT="$(cat /tmp/autopilot-repo-root)"', 'test -n "$REPO_ROOT"'];
/** Repo is parked here while a cached runtime is restored into /workspace. */
const REPO_ASIDE = "/tmp/autopilot-repo-aside";
const SNAPSHOT_PREFIX = "/workspace/.autopilot-snapshot-";
/** Where a streamed working-tree archive is unpacked inside the sandbox. */
const ARCHIVE_ROOT = "/workspace/repo";
const MAX_PARALLEL_WORKERS = 3;
/** Bounds on the structured report accepted from a worker. */
const MAX_REPORT_FINDINGS = 12;
const MAX_REPORT_SUMMARY_CHARS = 2_000;
const MAX_REPORT_LIST_ITEMS = 25;
let runningWorkers = 0;
const workerQueue: Array<() => void> = [];

export interface HotcellWorkerOptions {
  task: string;
  context?: string;
  model: string;
  timeoutMs?: number;
  /** Timeout for cell setup (checkout + worker CLI install), separate from research. */
  setupTimeoutMs?: number;
  /** npm spec for the worker CLI. Defaults to KIMIFLARE_WORKER_PACKAGE or the coordinator's own version. */
  workerPackage?: string;
  /** Use the locally cached runtime backup (default true; KIMIFLARE_WORKER_CACHE=0 disables). */
  useRuntimeCache?: boolean;
  /** Stream the working tree in rather than cloning origin (default true;
   *  KIMIFLARE_WORKER_ARCHIVE=0 forces cloning). */
  useArchive?: boolean;
  maxParallel?: number;
  cwd?: string;
  hotcellCommand?: string;
  processRunner?: HotcellProcessRunner;
  signal?: AbortSignal;
}

export interface HotcellProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
}

export type HotcellProcessRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs: number },
) => Promise<HotcellProcessResult>;

/** Run an independent read-only Autopilot research worker in a disposable Hotcell. */
export async function runHotcellWorker(options: HotcellWorkerOptions): Promise<WorkerResultMessage> {
  const workerId = `hotcell-${crypto.randomUUID().slice(0, 8)}`;
  const cwd = resolve(options.cwd ?? process.cwd());
  const model = options.model.trim();
  if (!model) throw new Error("Hotcell workers require the coordinator's explicit model ID.");
  validateModelId(model);
  if (options.task.length + (options.context?.length ?? 0) > MAX_PROMPT_CHARS) {
    throw new Error(`Hotcell worker prompt exceeds the ${MAX_PROMPT_CHARS.toLocaleString()} character limit.`);
  }
  if (options.signal?.aborted) return terminalResult(workerId, options.task, "cancelled", "Cancelled before worker setup.");
  const workerPackage = resolveWorkerPackage(options.workerPackage);

  await acquireSlot(options.maxParallel ?? MAX_PARALLEL_WORKERS, options.signal);
  let cellId: string | undefined;
  let result: WorkerResultMessage | undefined;
  const command = options.hotcellCommand ?? process.env.HOTCELL_BIN ?? "hotcell";
  const execute = options.processRunner ?? runProcess;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CELL_TIMEOUT_MS;

  try {
    // Hotcell's bare `hotcell` command is an interactive TTY front door; this
    // runner deliberately has no stdin. Start the daemon through its explicit,
    // idempotent non-interactive command instead of leaving a confirmation prompt
    // unanswered. `--defaults` accepts first-start defaults for agent use.
    const started = await execute(command, ["start", "--defaults"], {
      cwd, signal: options.signal, timeoutMs: 30_000,
    });
    if (started.code !== 0 || started.timedOut || started.aborted) {
      throw new Error(formatSetupFailure(started).replace("Hotcell setup failed", "Hotcell daemon startup failed"));
    }

    // Default: stream your working tree in (no clone, no credentials, no
    // push — works for private repos). Trees too large to copy fall back to
    // cloning origin and applying a patch of local changes.
    const useArchive = options.useArchive ?? process.env.KIMIFLARE_WORKER_ARCHIVE !== "0";
    const tree = useArchive ? await getWorkingTreeArchive(cwd) : { archive: null, files: 0, bytes: 0 };
    const repo = tree.archive ? null : await getRepositorySnapshot(cwd);
    const useCache = options.useRuntimeCache ?? process.env.KIMIFLARE_WORKER_CACHE !== "0";
    // Build or look up the cached runtime while the sandbox is created.
    const backupPromise = useCache
      ? ensureWorkerBackup({ packageSpec: workerPackage, command, execute, cwd, signal: options.signal })
      : Promise.resolve(null);
    const cellName = "autopilot-" + workerId;
    const created = await execute(command, [
      "create", "-n", "1", "--name", cellName,
      ...(repo ? ["--repo", repo.url, "--ref", repo.ref] : []),
      "--egress",
      "--memory", "1024", "--cpus", "2",
    ], { cwd, signal: options.signal, timeoutMs: 300_000 });
    cellId = parseCellId(created.stdout);
    if (!cellId) {
      try {
        const cells = await execute(command, ["ls"], { cwd, timeoutMs: 10_000 });
        cellId = parseNamedCellId(cells.stdout, cellName);
      } catch {
        // Best effort: the create command can omit its ID or fail after recording the cell.
      }
    }
    if (created.timedOut || created.aborted) {
      result = terminalResult(
        workerId,
        options.task,
        options.signal?.aborted ? "cancelled" : "timed_out",
        options.signal?.aborted ? "Cancelled during Hotcell setup." : "Hotcell setup timed out before the worker started.",
        model,
      );
      return result;
    }
    if (created.code !== 0) throw new Error(formatSetupFailure(created));
    if (!cellId) throw new Error("Hotcell created a sandbox but did not return a recognizable cell ID.");
    if (/no providers configured|providers:\s*\(none\)/i.test(created.stdout)) {
      result = terminalResult(workerId, options.task, "failed", "Hotcell has no OpenRouter gateway route. Run `hotcell keys add openrouter` on the daemon host, then retry.", model);
      return result;
    }

    const setupTimeoutMs = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
    const setupFailed = (step: string, r: HotcellProcessResult): WorkerResultMessage => {
      if (r.timedOut || r.aborted) {
        return terminalResult(
          workerId,
          options.task,
          options.signal?.aborted ? "cancelled" : "timed_out",
          options.signal?.aborted ? "Cancelled during subagent setup." : `Subagent setup timed out while ${step}.`,
          model,
        );
      }
      const detail = sanitizeHotcellDiagnostic(`${r.stderr}\n${r.stdout}`);
      return terminalResult(workerId, options.task, "failed", `Subagent setup failed (exit ${r.code}) while ${step}${detail ? `: ${detail}` : "."}`, model);
    };
    const run = (args: string[], timeout = setupTimeoutMs) => execute(command, args, { cwd, signal: options.signal, timeoutMs: timeout });

    // 1. Clone mode: locate the clone and, with a cached runtime, park it
    //    (a restore replaces /workspace wholesale). Then restore the runtime.
    const backupId = await backupPromise;
    if (repo) {
      const locate = await run(["exec", cellId, [...LOCATE_REPO_ROOT, ...(backupId ? [`mv "$(cat /tmp/autopilot-repo-root)" ${REPO_ASIDE}`] : [])].join(" && "), "--cwd", "/workspace"]);
      if (locate.code !== 0 || locate.timedOut || locate.aborted) return (result = setupFailed("locating the cloned repository", locate));
    }
    let usedCache = false;
    if (backupId) {
      const restored = await run(["restore", cellId, backupId], 120_000);
      usedCache = restored.code === 0;
      if (!usedCache && (restored.timedOut || restored.aborted)) return (result = setupFailed("restoring the cached subagent runtime", restored));
    }

    // 2. Stream in the working-tree archive, or the local-changes patch
    //    (written after the restore so it isn't wiped).
    const payload = tree.archive ?? repo?.patch ?? null;
    const chunks = payload ? chunkPayload(payload) : [];
    for (const [i, chunk] of chunks.entries()) {
      const wrote = await run(["files", "write", cellId, `${SNAPSHOT_PREFIX}${String(i).padStart(4, "0")}`, "--content", chunk], 60_000);
      if (wrote.code !== 0 || wrote.timedOut || wrote.aborted) return (result = setupFailed("copying your working tree", wrote));
    }

    // 3. Unpack (archive) or pin + patch (clone), and make sure the runtime
    //    exists. Its own exec and timeout, separate from research.
    const runtimeStep = usedCache
      ? `test -x ${WORKER_BIN}`
      : `npm install --prefix ${CACHED_WORKER_DIR} --no-audit --no-fund --loglevel=error ${shellQuote(workerPackage)} 1>&2`;
    const setupCommand = (repo
      ? [
          ...(backupId ? [`mv ${REPO_ASIDE} "$(cat /tmp/autopilot-repo-root)"`] : []),
          ...READ_REPO_ROOT,
          `git -C "$REPO_ROOT" fetch --quiet origin ${shellQuote(repo.commit)}`,
          `git -C "$REPO_ROOT" checkout --quiet --detach ${shellQuote(repo.commit)}`,
          ...(chunks.length
            ? [
                `cat ${SNAPSHOT_PREFIX}* | base64 -d > /tmp/autopilot-snapshot.patch`,
                `rm -f ${SNAPSHOT_PREFIX}*`,
                'git -C "$REPO_ROOT" apply --binary --whitespace=nowarn /tmp/autopilot-snapshot.patch',
              ]
            : []),
          runtimeStep,
        ]
      : [
          `mkdir -p ${ARCHIVE_ROOT}`,
          `cat ${SNAPSHOT_PREFIX}* | base64 -d | tar -xzf - -C ${ARCHIVE_ROOT}`,
          `rm -f ${SNAPSHOT_PREFIX}*`,
          `printf "%s" ${ARCHIVE_ROOT} > /tmp/autopilot-repo-root`,
          runtimeStep,
        ]).join(" && ");
    const setup = await run(["exec", cellId, setupCommand, "--cwd", "/workspace"]);
    if (setup.code !== 0 || setup.timedOut || setup.aborted) {
      return (result = setupFailed(usedCache ? "preparing the repository" : `installing ${workerPackage}`, setup));
    }
    const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    const snapshotNote = repo
      ? (useArchive ? `Your working tree (${mb(tree.bytes)} compressed) was too large to copy, so the subagent cloned origin/${repo.ref}` : `The subagent cloned origin/${repo.ref}`) +
        (repo.note ? `. ${repo.note}` : repo.changedFiles > 0 ? ` and applied your ${repo.changedFiles} local change${repo.changedFiles === 1 ? "" : "s"}.` : ".")
      : `The subagent saw your current working tree (${tree.files} file${tree.files === 1 ? "" : "s"}, uncommitted changes included).`;

    const prompt = [
      "You are an isolated, read-only research worker. You cannot edit files, run shell commands, push, publish, or call write-capable integrations.",
      "Use the exact requested model and return concise findings, recommendations, and relevant file paths. Do not claim to have changed files.",
      WORKER_REPORT_INSTRUCTIONS,
      `Mission:\n${options.task}`,
      options.context ? `Coordinator context:\n${options.context}` : "",
    ].filter(Boolean).join("\n\n");
    // Use base64 to pass the bounded mission as one quoted shell argument. The
    // host key is never passed; Hotcell injects its revocable gateway token.
    const encodedPrompt = Buffer.from(prompt, "utf8").toString("base64");
    const shellCommand = [
      ...READ_REPO_ROOT,
      'cd "$REPO_ROOT"',
      'export OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL%/}/v1"',
      `PROMPT="$(printf '%s' '${encodedPrompt}' | base64 -d)"`,
      `${WORKER_BIN} --format json --model ${shellQuote(model)} --worker-profile research -p "$PROMPT"`,
    ].join(" && ");
    const execution = await execute(command, ["exec", cellId, shellCommand, "--cwd", "/workspace"], {
      cwd, signal: options.signal, timeoutMs,
    });
    const stats = await execute(command, ["stats", cellId], { cwd, timeoutMs: 30_000 }).catch(() => undefined);
    const metrics = stats?.code === 0 ? parseHotcellStats(stats.stdout) : {};
    const json = parsePrintOutput(execution.stdout);
    const summary = typeof json?.text === "string" ? json.text.trim() : execution.stdout.trim();
    const tokensUsed = typeof json?.usage?.totalTokens === "number" ? json.usage.totalTokens : 0;
    const budgetExhausted = execution.code === 42;
    const diagnostic = `${execution.stdout}\n${execution.stderr}`.toLowerCase();
    const executionDiagnostic = sanitizeHotcellDiagnostic(execution.stderr);
    const spendExhausted = execution.code !== 0 && /egress spend cap exceeded/.test(diagnostic);
    const status = execution.timedOut
      ? "timed_out"
      : execution.aborted
        ? options.signal?.aborted ? "cancelled" : "failed"
        : spendExhausted ? "spend_exhausted"
        : budgetExhausted ? "budget_exhausted"
        : execution.code === 0 ? "completed" : "failed";
    const report = parseWorkerReport(summary);
    const findings: WorkerFinding[] = report
      ? report.findings
      : summary
        ? [{ topic: "Research findings", summary: summary.slice(0, 40_000), confidence: "medium", sources: [], relevance: "high" }]
        : [];
    result = {
      workerId,
      status,
      task: options.task,
      findings,
      recommendations: [],
      filesRead: report?.filesRead ?? [],
      ...(snapshotNote ? { snapshotNote } : {}),
      ...(report ? { structured: true, openQuestions: report.openQuestions } : {}),
      webSources: [],
      costUsd: metrics.costUsd ?? 0,
      tokensUsed: metrics.tokensUsed ?? tokensUsed,
      reasoning: "",
      model,
      exitCode: execution.code,
      ...(budgetExhausted || spendExhausted ? { budgetExceeded: true, partialResult: findings.length > 0 } : {}),
      ...(execution.code !== 0 && !budgetExhausted
        ? {
            error: status === "timed_out" ? "Worker timed out."
              : status === "cancelled" ? "Worker cancelled."
              : spendExhausted ? "Hotcell gateway egress spend cap exceeded."
              : execution.outputLimitExceeded ? "Worker output exceeded the 1 MB result limit."
              : /unknown model|model.{0,30}(?:not found|invalid|unavailable|unsupported)/i.test(diagnostic) ? "The requested model is unavailable in the Hotcell OpenRouter gateway."
              : /no openrouter api key|openrouter.{0,30}(?:key|gateway).{0,30}(?:missing|not configured)/i.test(diagnostic) ? "Hotcell OpenRouter gateway credentials are not configured. Run `hotcell keys add openrouter` on the daemon host."
              : `Worker process exited with code ${execution.code}${executionDiagnostic ? `: ${executionDiagnostic}` : "."}`,
          }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Hotcell worker error.";
    result = terminalResult(workerId, options.task, options.signal?.aborted ? "cancelled" : "failed", message, model);
  } finally {
    if (cellId) {
      try {
        // Removing the cell terminates any remaining process and revokes its
        // cell-scoped gateway token, including on timeout/cancellation paths.
        const removed = await execute(command, ["rm", cellId], { cwd, timeoutMs: 30_000 });
        if (removed.code !== 0 && result) {
          result = {
            ...result,
            status: result.status === "completed" ? "failed" : result.status,
            error: [result.error, "Hotcell cleanup failed; remove the cell manually to revoke its gateway token."].filter(Boolean).join(" "),
          };
        }
      } catch {
        if (result) {
          result = {
            ...result,
            status: result.status === "completed" ? "failed" : result.status,
            error: [result.error, "Hotcell cleanup failed; remove the cell manually to revoke its gateway token."].filter(Boolean).join(" "),
          };
        }
      }
    }
    releaseSlot();
  }
  return result!;
}


const WORKER_REPORT_INSTRUCTIONS = [
  "Finish your answer with one fenced ```json block, and nothing after it, of exactly this shape:",
  '{"findings":[{"topic":"short title","summary":"what you found and why it matters","files":["path/to/file.ts:123"],"confidence":"high|medium|low"}],"openQuestions":["what you could not determine"],"filesRead":["path/to/file.ts"]}',
  "Cite repository-relative file paths (with line numbers where useful) for every finding. Use low confidence for anything you did not verify in the code.",
].join("\n");

export interface WorkerReport {
  findings: WorkerFinding[];
  openQuestions: string[];
  filesRead: string[];
}

/** Parse the worker's trailing ```json report. Returns null when it is
 *  missing or invalid, so callers fall back to the raw text. Sizes are bounded. */
export function parseWorkerReport(text: string): WorkerReport | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const raw = blocks.at(-1)?.[1];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { findings?: unknown }).findings)) return null;
  const obj = parsed as { findings: unknown[]; openQuestions?: unknown; filesRead?: unknown };
  const strings = (value: unknown, maxChars = 300): string[] =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, MAX_REPORT_LIST_ITEMS).map((v) => v.trim().slice(0, maxChars))
      : [];
  const findings: WorkerFinding[] = [];
  for (const item of obj.findings.slice(0, MAX_REPORT_FINDINGS)) {
    if (!item || typeof item !== "object") continue;
    const f = item as { topic?: unknown; summary?: unknown; files?: unknown; confidence?: unknown };
    if (typeof f.summary !== "string" || !f.summary.trim()) continue;
    const confidence = f.confidence === "high" || f.confidence === "low" ? f.confidence : "medium";
    findings.push({
      topic: typeof f.topic === "string" && f.topic.trim() ? f.topic.trim().slice(0, 120) : "Finding",
      summary: f.summary.trim().slice(0, MAX_REPORT_SUMMARY_CHARS),
      confidence,
      sources: strings(f.files),
      relevance: "high",
    });
  }
  if (findings.length === 0) return null;
  return { findings, openQuestions: strings(obj.openQuestions, 500), filesRead: strings(obj.filesRead) };
}

/** npm spec for the worker CLI: explicit option, KIMIFLARE_WORKER_PACKAGE, or
 *  the coordinator's own published version so worker flags always match. */
export function resolveWorkerPackage(override?: string): string {
  const spec = (override ?? process.env.KIMIFLARE_WORKER_PACKAGE ?? `${PACKAGE_NAME}@${getAppVersion()}`).trim();
  if (!spec || !PACKAGE_SPEC.test(spec)) {
    throw new Error(`Invalid Hotcell worker package spec: ${JSON.stringify(spec)}.`);
  }
  return spec;
}

export function parseCellId(output: string): string | undefined {
  const uuid = output.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{4,}){0,4}\b/gi)?.at(-1);
  if (uuid) return uuid;
  const labeled = output.match(/(?:sandbox|cell)(?:\s+id)?\s*[:= ]\s*([a-z0-9][a-z0-9_-]{7,79})/i)?.[1];
  if (labeled) return labeled;
  return output.split(/\r?\n/).map((line) => line.trim()).reverse().find((line) => /^[a-z0-9][a-z0-9_-]{7,79}$/i.test(line));
}

export function parseNamedCellId(output: string, name: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[1] === name && /^[a-z0-9][a-z0-9_-]{7,79}$/i.test(columns[0] ?? "")) return columns[0];
  }
  return undefined;
}

function formatSetupFailure(result: HotcellProcessResult): string {
  const detail = sanitizeHotcellDiagnostic(`${result.stderr}\n${result.stdout}`);
  return `Hotcell setup failed (exit ${result.code})${detail ? `: ${detail}` : ". Check that the daemon, repository access, and gateway route are configured."}`;
}

function sanitizeHotcellDiagnostic(text: string): string {
  return text
    .replace(/\b(?:sk-or-v1-|sk-ant-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .trim()
    .slice(-1_500);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseHotcellStats(output: string): { tokensUsed?: number; costUsd?: number } {
  const llm = output.match(/LLM:\s*([\d,]+) calls,\s*([\d,]+) in \+ ([\d,]+) out tokens,\s*\$([\d.]+)/i);
  const totalCost = output.match(/Cost:\s*\$?([\d.]+)/i);
  const tokensUsed = llm
    ? Number(llm[2]!.replaceAll(",", "")) + Number(llm[3]!.replaceAll(",", ""))
    : undefined;
  const costUsd = totalCost ? Number(totalCost[1]) : llm ? Number(llm[4]) : undefined;
  return {
    ...(Number.isFinite(tokensUsed) ? { tokensUsed } : {}),
    ...(Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

export function parsePrintOutput(stdout: string): { text?: string; usage?: { totalTokens?: number } } | undefined {
  const candidate = stdout.trim();
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as { text?: string; usage?: { totalTokens?: number } };
  } catch {
    return undefined;
  }
}

async function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs: number },
): Promise<HotcellProcessResult> {
  if (options.signal?.aborted) return { code: 130, stdout: "", stderr: "", aborted: true };
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    const terminate = () => {
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceTimer.unref();
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        terminate();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolvePromise({
        code: code ?? (aborted ? 130 : 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        aborted,
        timedOut,
        outputLimitExceeded,
      });
    });
  });
}

function terminalResult(
  workerId: string,
  task: string,
  status: "cancelled" | "timed_out" | "failed",
  error: string,
  model?: string,
): WorkerResultMessage {
  return {
    workerId, status, task, findings: [], recommendations: [], filesRead: [], webSources: [],
    costUsd: 0, tokensUsed: 0, reasoning: "", ...(model ? { model } : {}), error,
  };
}

export async function acquireSlot(limit: number, signal?: AbortSignal): Promise<void> {
  const cap = Math.max(1, Math.min(MAX_PARALLEL_WORKERS, Math.floor(limit) || 1));
  if (runningWorkers < cap) {
    runningWorkers++;
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    // A waiter woken by releaseSlot() resolves without the abort event ever
    // firing, so `{ once: true }` alone leaves its listener on the (long-lived)
    // turn signal. Remove it explicitly on every exit path (#967).
    const cleanup = () => {
      signal?.removeEventListener("abort", wake);
      const index = workerQueue.indexOf(wake);
      if (index >= 0) workerQueue.splice(index, 1);
    };
    const wake = () => {
      if (settled) return;
      if (signal?.aborted) {
        settled = true;
        cleanup();
        reject(new Error("Hotcell worker cancelled while waiting for a slot."));
        return;
      }
      if (runningWorkers < cap) {
        settled = true;
        cleanup();
        runningWorkers++;
        resolvePromise();
      }
    };
    workerQueue.push(wake);
    signal?.addEventListener("abort", wake, { once: true });
  });
}

export function releaseSlot(): void {
  runningWorkers = Math.max(0, runningWorkers - 1);
  for (const wake of workerQueue.slice()) wake();
}
