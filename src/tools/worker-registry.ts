/**
 * Process-wide registry of running subagents.
 *
 * Each worker gets its own cancel handle, linked to (but separate from) the
 * turn's abort signal: the user can stop one subagent without interrupting
 * the turn or the other workers, and interrupting a turn is a separate,
 * explicit action. Hosts subscribe to render a live list.
 */

export interface RunningWorker {
  id: string;
  /** Short display number (#1, #2, …); restarts when no workers are running. */
  index: number;
  task: string;
  model: string;
  startedAt: number;
  status: "running" | "cancelling";
  /** Started with `background: true`: the turn didn't wait for it. */
  background?: boolean;
  /** Session that started it (background results are delivered there). */
  sessionId?: string;
}

/** A finished worker's outcome, kept for background workers until delivered. */
export interface FinishedWorker {
  id: string;
  index: number;
  task: string;
  model: string;
  background: boolean;
  sessionId?: string;
  status: string;
  /** The formatted report (or failure explanation) for the coordinator. */
  output: string;
  costUsd?: number;
  startedAt: number;
  finishedAt: number;
  /** Shown to the coordinator already (via worker_result, wait_for or the inbox). */
  delivered: boolean;
}

export interface WorkerHandle {
  id: string;
  index: number;
  /** Aborts when the turn aborts or the user cancels this worker. */
  signal: AbortSignal;
  /** True when the user cancelled this specific worker. */
  readonly cancelledByUser: boolean;
  /** Record the outcome (background workers keep it for delivery). Call before finish(). */
  complete(outcome: { status: string; output: string; costUsd?: number }): void;
  /** Remove the worker from the registry. Idempotent. */
  finish(): void;
}

interface Entry {
  info: RunningWorker;
  controller: AbortController;
}

export class WorkerRegistry {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(workers: RunningWorker[]) => void>();
  private finished = new Map<string, FinishedWorker>();
  private finishListeners = new Set<(worker: FinishedWorker) => void>();
  private waiters = new Map<string, Array<(worker: FinishedWorker) => void>>();
  private nextIndex = 1;
  private nextId = 1;

  start(task: string, model: string, parent?: AbortSignal, opts: { background?: boolean; sessionId?: string } = {}): WorkerHandle {
    // Display numbers restart when nothing is running and no background result is waiting.
    if (this.entries.size === 0 && ![...this.finished.values()].some((f) => !f.delivered)) this.nextIndex = 1;
    const controller = new AbortController();
    const info: RunningWorker = {
      id: `worker-${this.nextId++}`,
      index: this.nextIndex++,
      task,
      model,
      startedAt: Date.now(),
      status: "running",
      ...(opts.background ? { background: true } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    };
    this.entries.set(info.id, { info, controller });
    this.emit();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let cancelledByUser = false;
    controller.signal.addEventListener("abort", () => {
      cancelledByUser = true;
    }, { once: true });
    return {
      id: info.id,
      index: info.index,
      signal,
      get cancelledByUser() {
        return cancelledByUser;
      },
      complete: (outcome) => {
        const done: FinishedWorker = {
          id: info.id,
          index: info.index,
          task,
          model,
          background: opts.background === true,
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          status: cancelledByUser ? "cancelled" : outcome.status,
          output: outcome.output,
          ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
          startedAt: info.startedAt,
          finishedAt: Date.now(),
          delivered: false,
        };
        // Foreground results go straight back to the turn; only background ones are kept.
        if (done.background) this.finished.set(info.id, done);
        for (const resolve of this.waiters.get(info.id) ?? []) resolve(done);
        this.waiters.delete(info.id);
        for (const l of this.finishListeners) {
          try {
            l(done);
          } catch {
            // listeners must not break the worker lifecycle
          }
        }
      },
      finish: () => {
        if (this.entries.delete(info.id)) this.emit();
      },
    };
  }

  /** A worker by id or display number: running, or finished in the background. */
  find(ref: string | number): { running?: RunningWorker; finished?: FinishedWorker } | null {
    const key = String(ref).replace(/^#/, "");
    const running = [...this.entries.values()].find((e) => e.info.id === key || String(e.info.index) === key);
    if (running) return { running: { ...running.info } };
    const finished = [...this.finished.values()].find((f) => f.id === key || String(f.index) === key);
    return finished ? { finished } : null;
  }

  /** Finished background workers, optionally for one session. */
  listFinished(sessionId?: string): FinishedWorker[] {
    return [...this.finished.values()].filter((f) => !sessionId || f.sessionId === sessionId);
  }

  /** Wait for a worker to finish (resolves immediately if it already has). */
  waitFor(ref: string | number, signal?: AbortSignal): Promise<FinishedWorker> {
    const found = this.find(ref);
    if (!found) return Promise.reject(new Error(`No subagent ${ref}`));
    if (found.finished) return Promise.resolve(found.finished);
    const id = found.running!.id;
    return new Promise<FinishedWorker>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const list = this.waiters.get(id) ?? [];
      list.push((w) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(w);
      });
      this.waiters.set(id, list);
    });
  }

  /** Mark a finished worker as seen by the coordinator. */
  markDelivered(id: string): void {
    const f = this.finished.get(id);
    if (f) f.delivered = true;
  }

  /** Background results for a session not yet shown to its coordinator; marks them delivered. */
  takeUndelivered(sessionId: string | undefined): FinishedWorker[] {
    const out = [...this.finished.values()].filter((f) => !f.delivered && (f.sessionId ?? undefined) === (sessionId ?? undefined));
    for (const f of out) f.delivered = true;
    return out;
  }

  /** Called whenever a worker finishes (hosts show a notice, the SDK emits an event). */
  onFinished(listener: (worker: FinishedWorker) => void): () => void {
    this.finishListeners.add(listener);
    return () => {
      this.finishListeners.delete(listener);
    };
  }

  /** Forget a session's finished background results (session disposed). */
  clearFinished(sessionId?: string): void {
    for (const [id, f] of this.finished) if (!sessionId || f.sessionId === sessionId) this.finished.delete(id);
  }

  list(): RunningWorker[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.info }));
  }

  /** Cancel one worker by display number or id. Returns it, or null if not running. */
  cancel(ref: number | string): RunningWorker | null {
    const entry = [...this.entries.values()].find((e) =>
      typeof ref === "number" ? e.info.index === ref : e.info.id === ref || String(e.info.index) === ref.replace(/^#/, ""),
    );
    if (!entry || entry.info.status === "cancelling") return null;
    entry.info.status = "cancelling";
    entry.controller.abort();
    this.emit();
    return { ...entry.info };
  }

  /** Cancel every running worker. Returns how many were cancelled. */
  cancelAll(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.info.status === "cancelling") continue;
      entry.info.status = "cancelling";
      entry.controller.abort();
      n++;
    }
    if (n > 0) this.emit();
    return n;
  }

  subscribe(listener: (workers: RunningWorker[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const workers = this.list();
    for (const listener of this.listeners) {
      try {
        listener(workers);
      } catch {
        // A rendering listener must never break worker lifecycle.
      }
    }
  }
}

export const workerRegistry = new WorkerRegistry();
