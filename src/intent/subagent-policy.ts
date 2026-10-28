import { askJev, JEV_TIMEOUT_MS, type JevAnswer, type JevQuestion, type AskJevOptions } from "../agent/jev.js";

export type SubagentPolicy = "off" | "suggest" | "auto";
export type SubagentGuidanceKind = "none" | "explicit-delegate" | "explicit-sequential" | "suggest" | "auto-delegate";

export interface SubagentGuidance {
  kind: SubagentGuidanceKind;
  reason: string;
  probability?: number;
  directive?: string;
  /** auto mode: the directive sharpened by a Jev yes/no check. Never rejects;
   *  resolves to `directive` when Jev is unsure or unavailable. Hosts pass it
   *  to the loop, which awaits it alongside other pre-turn work. */
  refinedDirective?: Promise<string | undefined>;
}

export function allowsSubagentDispatch(kind: SubagentGuidanceKind): boolean {
  return kind === "explicit-delegate" || kind === "suggest" || kind === "auto-delegate";
}

export interface ResolveSubagentGuidanceOptions {
  prompt: string;
  tier: "light" | "medium" | "heavy";
  policy: SubagentPolicy;
  apiKey?: string;
  customEndpoint?: boolean;
  signal?: AbortSignal;
  ask?: (apiKey: string, question: JevQuestion, options?: AskJevOptions) => Promise<JevAnswer>;
}

const EXPLICIT_NO = /\b(?:do\s+not|don't|dont|never|avoid|without|no)\s+(?:(?:(?:want\s+to\s+)?(?:use|using|spawn|call|ask|start|launch|skip|run|spin(?:\s+up)?))\s+)?(?:(?:any|the|a|some|several|multiple|parallel|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:sub[- ]?agents?|agents?|workers?)\b|\b(?:do\s+not|don't|dont|never|avoid|without|no)\s+delegat(?:e|ion|ing)\b|\bwork\s+sequentially\b/i;
const EXPLICIT_YES = /\b(?:use|spawn|call|start|launch|ask|send|run|spin(?:\s+up)?|delegate\s+to)\s+(?:(?:some|several|multiple|parallel|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:sub[- ]?agents?|agents?|workers?)\b|\b(?:parallelize|split)\b.{0,50}\b(?:agents?|workers?|subtasks?)\b/i;
const SEQUENTIAL_DEPENDENCY = /\b(?:one\s+at\s+a\s+time|sequentially|in\s+sequence|in\s+dependency\s+order|tightly\s+coupled|same\s+(?:file|function|module)|first\b.{0,80}\bbefore\b|before\b.{0,80}\bthen\b|step[- ]by[- ]step)\b/i;
const CLEAR_PARALLEL = /\b(?:independent\s+(?:research|tasks?|questions?|work)|in\s+parallel|parallel\s+agents?|separately\s+investigate)\b/i;
const AMBIGUOUS_CANDIDATE = /\b(?:research|investigat\w*|audit|compare|contrast|review|comprehensive|across\s+(?:the\s+)?(?:codebase|repo|repository)|entire\s+(?:codebase|repo|repository)|multiple\s+(?:systems|modules|approaches|sources))\b/i;

export const SUBAGENT_JEV_TIMEOUT_MS = Math.min(JEV_TIMEOUT_MS, 4_000);
export const SUBAGENT_JEV_OPTIONS = ["delegate", "sequential"] as const;
const SUGGEST_THRESHOLD = 0.65;
const MAX_JEV_PROMPT_CHARS = 1_200;

function directiveFor(kind: SubagentGuidanceKind): string | undefined {
  if (kind === "explicit-sequential") {
    return "The user explicitly asked not to delegate. Do not call the subagent tool; handle the task in this session and respect any stated dependencies.";
  }
  if (kind === "explicit-delegate") {
    return "The user explicitly asked for subagents. Split the request into specific, self-contained investigations that can proceed independently, launch them with the subagent tool in the same response so they run in parallel, then synthesize their findings before doing dependent work yourself. Subagents read and search but cannot edit. Do not delegate tightly coupled or sequential steps. The tool's permission prompt still applies.";
  }
  if (kind === "suggest") {
    return "This task may have independent parts. If you can define two or more specific, self-contained investigations, consider the subagent tool (launch them in the same response so they run in parallel). The tool's permission prompt is the user's confirmation; never assume approval. Keep dependent work in this session.";
  }
  if (kind === "auto-delegate") {
    return "This task may benefit from independent investigation. Delegate only when each part needs its own substantial investigation (rough guide: more than a few file reads), such as separate subsystems or independent research questions. If so, launch one subagent per part with the subagent tool in the same response, then handle dependent and editing work yourself. Never delegate a step whose answer is a single sentence or a small, tightly coupled, or step-by-step task. If a subagent cannot run, say so plainly and continue yourself.";
  }
  return undefined;
}

function result(kind: SubagentGuidanceKind, reason: string, probability?: number): SubagentGuidance {
  const directive = directiveFor(kind);
  return {
    kind,
    reason,
    ...(probability === undefined ? {} : { probability }),
    ...(directive ? { directive } : {}),
  };
}

/** Resolve harness guidance without ever launching a worker itself. */
export async function resolveSubagentGuidance(options: ResolveSubagentGuidanceOptions): Promise<SubagentGuidance> {
  const prompt = options.prompt.trim();
  if (EXPLICIT_NO.test(prompt)) return result("explicit-sequential", "explicit user instruction");
  if (EXPLICIT_YES.test(prompt)) return result("explicit-delegate", "explicit user instruction");
  if (options.policy === "off") return result("none", "automatic delegation is off");
  if (SEQUENTIAL_DEPENDENCY.test(prompt)) return result("none", "routine or sequential task");
  if (CLEAR_PARALLEL.test(prompt)) {
    return result(options.policy === "auto" ? "auto-delegate" : "suggest", "independent work is explicit");
  }
  if (options.tier === "light") return result("none", "routine or sequential task");
  // Auto delegation is offered only when the prompt signals independent work:
  // an explicit parallel request above, or research/audit/multi-area language.
  // Task size alone is not evidence that workers will help.
  if (options.policy === "auto" && !AMBIGUOUS_CANDIDATE.test(prompt)) {
    return result("none", "no parallel-work signal");
  }
  if (options.policy === "auto") {
    const base = result("auto-delegate", "substantial task; coordinator assesses independence");
    if (!options.apiKey || options.customEndpoint) return base;
    return { ...base, refinedDirective: refineAutoDirective(prompt, options.apiKey, base.directive, options) };
  }
  if (!AMBIGUOUS_CANDIDATE.test(prompt)) return result("none", "no parallel-work signal");
  if (!options.apiKey || options.customEndpoint) return result("none", "Jev is unavailable for this provider configuration");
  if (options.signal?.aborted) return result("none", "turn cancelled before Jev advice");

  const safePrompt = redactPrompt(prompt).slice(0, MAX_JEV_PROMPT_CHARS);
  const question: JevQuestion = {
    kind: "choose",
    prompt: [
      "Choose whether this task benefits from independent subagent research before coordinator synthesis.",
      "Delegate only if useful work can proceed independently; otherwise keep the task sequential.",
      `Task effort: ${options.tier}. User task: ${safePrompt}`,
    ].join("\n"),
    options: [...SUBAGENT_JEV_OPTIONS],
  };
  const ask = options.ask ?? askJev;
  const timeout = AbortSignal.timeout(SUBAGENT_JEV_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const answer = await ask(options.apiKey, question, { signal });
    const probability = answer.type === "choice" ? answer.probabilities?.delegate : undefined;
    if (probability === undefined || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return result("none", "Jev returned no usable delegation probability");
    }
    if (probability >= SUGGEST_THRESHOLD) return result("suggest", "Jev sees a possible parallel-work benefit", probability);
    return result("none", "Jev recommends sequential work", probability);
  } catch {
    // Advice must never block the main turn or turn a transient Jev failure into dispatch.
    return result("none", "Jev unavailable; continue in the main session");
  }
}

/** Jev probability above which the auto directive tells the agent to delegate
 *  rather than merely consider it. Kept high: live checks put a clearly
 *  sequential rename task at 0.63. */
export const AUTO_DELEGATE_STRONG_THRESHOLD = 0.8;
export const AUTO_JEV_TIMEOUT_MS = 3_000;

const STRONG_AUTO_DIRECTIVE =
  "This task has parts that can be investigated independently. Before doing the work yourself, identify those parts and launch one subagent per part with the subagent tool, all in the same response, so they run in parallel; then do the dependent and editing work yourself using their findings. Only skip delegation if, on inspection, the parts turn out to depend on each other.";

/** Ask Jev a yes/no question about independence; resolve to the strong
 *  directive when it is confident, else the base directive. Never rejects. */
async function refineAutoDirective(
  prompt: string,
  apiKey: string,
  baseDirective: string | undefined,
  options: Pick<ResolveSubagentGuidanceOptions, "signal" | "ask">,
): Promise<string | undefined> {
  const timeout = AbortSignal.timeout(AUTO_JEV_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const answer = await (options.ask ?? askJev)(apiKey, {
      kind: "yes",
      prompt: `Does this coding task contain two or more parts that can be investigated independently and in parallel? Task: ${redactPrompt(prompt).slice(0, MAX_JEV_PROMPT_CHARS)}`,
    }, { signal });
    const p = answer.type === "noul" ? answer.noul : undefined;
    return typeof p === "number" && p >= AUTO_DELEGATE_STRONG_THRESHOLD ? STRONG_AUTO_DIRECTIVE : baseDirective;
  } catch {
    return baseDirective;
  }
}

export function redactPrompt(prompt: string): string {
  return prompt
    .replace(/\b(?:sk-or-v1-|sk-ant-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]");
}
