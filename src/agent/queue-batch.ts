export interface QueueDrainState {
  busy: boolean;
  queuePlanOpen: boolean;
  supervisorIdle: boolean;
  hasPendingWork: boolean;
}

/** Whether the app can start pending queue work at this point in the turn lifecycle. */
export function canDrainQueue(state: QueueDrainState): boolean {
  return !state.busy && !state.queuePlanOpen && state.supervisorIdle && state.hasPendingWork;
}

export interface QueuedPrompt {
  full: string;
  display: string;
  key: string;
  /** Original prompt text represented by this item after batching. */
  batchPrompts?: string[];
  /** Original queue rows represented by this item after batching. */
  sourceKeys?: string[];
  /** Mid-turn triage outcome while this item waits in the queue (#725). */
  triage?: { source: "rule" | "model" | "default" | "pending"; reason: string };
}

/** Build one coordinated user turn from ordinary queued chat prompts. */
export function createQueueBatch(items: QueuedPrompt[]): QueuedPrompt | null {
  if (items.length < 2) return null;
  if (items.some((item) => isCommand(item.full))) return null;

  const prompts = items.flatMap((item) => item.batchPrompts ?? [item.full.trim()]);
  const sourceKeys = items.flatMap((item) => item.sourceKeys ?? [item.key]);
  const numberedPrompts = prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n\n");
  const full = [
    `The user chose to group ${prompts.length} queued follow-ups into one coordinated task.`,
    "First identify dependencies and an efficient order. Treat every follow-up as a requirement. Delegate bounded, independent research to subagents when it materially helps; worker calls still require the normal user permission. Keep dependent changes coordinated in this session, and do not have multiple workers edit overlapping files.",
    "",
    "Queued follow-ups:",
    numberedPrompts,
  ].join("\n");
  const display = `Coordinate ${prompts.length} queued follow-ups as one task. Use subagents to research independent parts where useful; keep dependent changes coordinated.`;

  return {
    full,
    display,
    key: sourceKeys[0]!,
    batchPrompts: prompts,
    sourceKeys,
  };
}

function isCommand(prompt: string): boolean {
  const trimmed = prompt.trimStart();
  return trimmed.startsWith("/") || trimmed.startsWith("!");
}
