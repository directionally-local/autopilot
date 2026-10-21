// Shapes App shares with the Camouflage view through the bridge snapshot.

/** A tool call as the transcript shows it. */
export interface ToolEventState {
  id: string;
  name: string;
  args: string;
  status: "queued" | "running" | "done" | "error" | "blocked" | "cancelled" | "rejected";
  result?: string;
  render?: { title: string; body?: string; diff?: { path: string; before: string; after: string } };
  expanded?: boolean;
  startedAt?: number;
}

/** One entry in the conversation transcript. */
export type ChatEvent =
  | { kind: "user"; key: string; text: string; images?: string[]; queued?: boolean }
  | {
      kind: "assistant";
      key: string;
      id: number;
      text: string;
      reasoning: string;
      streaming: boolean;
    }
  | ({ kind: "tool"; key: string } & ToolEventState)
  | { kind: "info"; key: string; text: string; pending?: boolean; /** "warn": shown in the warning colour (e.g. a failed hook). */ tone?: "warn" }
  | { kind: "error"; key: string; text: string }
  | { kind: "jev"; key: string; result: string; probability?: string; tone: "yes" | "no" | "neutral"; receipt: string }
  | { kind: "memory"; key: string; text: string }
  | {
      kind: "meta";
      key: string;
      intentTier?: "light" | "medium" | "heavy";
      skillsActive?: number;
      memoryRecalled?: boolean;
    }
  | {
      kind: "api_error";
      key: string;
      httpStatus?: number;
      code?: number;
      message: string;
      /** The active provider's status page, when it has one. */
      statusUrl?: string;
    }
  | {
      kind: "qrcode";
      key: string;
      lines: string[];
      caption: string;
    };

/** What the agent is doing right now in a turn. */
export type TurnPhase = "generating" | "executing" | "waiting";

/** A file-path completion candidate for `@` mentions. */
export interface FilePickerItem {
  name: string;
  isDirectory: boolean;
}

/** The answer to "the plan is ready — what next?". */
export type PlanCompleteChoice = "auto" | "edit" | "continue";
