import { resolve } from "node:path";
import type {
  PermissionOption,
  RequestPermissionOutcome,
  ToolCall as AcpToolCall,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
  ToolCallLocation,
} from "@agentclientprotocol/sdk";
import type { ToolCall } from "../agent/messages.js";
import type { PermissionDecisionResult, ToolResult } from "../tools/executor.js";

/**
 * Map a Autopilot tool name to an ACP ToolKind.
 */
/** ACP wants absolute paths; tools take paths relative to the session's folder. */
function absolute(path: string, cwd: string | undefined): string {
  return cwd ? resolve(cwd, path) : path;
}

export function toolKind(name: string): ToolKind {
  switch (name) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    case "glob":
    case "grep":
      return "search";
    case "web_fetch":
      return "fetch";
    case "tasks_set":
    case "expand_artifact":
      return "think";
    default:
      return "other";
  }
}

/**
 * Build a human-readable title for an ACP tool call from Autopilot's tool call.
 */
export function toolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read": {
      const path = typeof args.path === "string" ? args.path : "file";
      let label = `Read ${path}`;
      if (typeof args.offset === "number" || typeof args.limit === "number") {
        const from = typeof args.offset === "number" ? args.offset : 1;
        const to =
          typeof args.limit === "number" ? from + args.limit - 1 : undefined;
        label += to !== undefined ? ` (${from}-${to})` : ` (from ${from})`;
      }
      return label;
    }
    case "write": {
      const path = typeof args.path === "string" ? args.path : "file";
      return `Write ${path}`;
    }
    case "edit": {
      const path = typeof args.path === "string" ? args.path : "file";
      return `Edit ${path}${args.replace_all ? " (replace_all)" : ""}`;
    }
    case "bash": {
      let cmd = typeof args.command === "string" ? args.command.trim() : "";
      // Strip leading cd + && to show the actual command
      const m = cmd.match(/^cd\s+[^\s&;]+\s*(?:&&|;)\s*(.*)$/);
      if (m) cmd = m[1]!.trim();
      return `$ ${cmd}`.slice(0, 120);
    }
    case "glob": {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      return `Find ${pattern}`;
    }
    case "grep": {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      let label = "grep";
      if (args.case_insensitive) label += " -i";
      if (typeof args.glob === "string") label += ` --include="${args.glob}"`;
      label += ` "${pattern}"`;
      if (typeof args.path === "string") label += ` ${args.path}`;
      return label.slice(0, 120);
    }
    case "web_fetch": {
      const url = typeof args.url === "string" ? args.url : "";
      return `GET ${url}`.slice(0, 120);
    }
    case "tasks_set":
      return `Update tasks (${Array.isArray(args.tasks) ? args.tasks.length : 0} items)`;
    case "expand_artifact":
      return `Expand ${typeof args.artifact_id === "string" ? args.artifact_id : "artifact"}`;
    default:
      return name;
  }
}

/**
 * Extract file locations from a tool call's arguments for ACP "follow-along".
 */
function toolLocations(
  name: string,
  args: Record<string, unknown>,
  cwd?: string,
): ToolCallLocation[] {
  const path = typeof args.path === "string" ? absolute(args.path, cwd) : null;
  if (!path) return [];
  switch (name) {
    case "read":
      return [
        { path, line: typeof args.offset === "number" ? args.offset : 1 },
      ];
    case "write":
    case "edit":
      return [{ path }];
    case "glob":
    case "grep":
      return [{ path }];
    default:
      return [];
  }
}

/**
 * Build the initial ACP ToolCallContent from a Autopilot tool call.
 * For write/edit, we send diff content blocks. For everything else, empty.
 */
function toolContent(
  name: string,
  args: Record<string, unknown>,
  cwd?: string,
): ToolCallContent[] {
  switch (name) {
    case "write": {
      const path = typeof args.path === "string" ? absolute(args.path, cwd) : "";
      const content = typeof args.content === "string" ? args.content : "";
      return [
        {
          type: "diff",
          path,
          oldText: null,
          newText: content,
        },
      ];
    }
    case "edit": {
      const path = typeof args.path === "string" ? absolute(args.path, cwd) : "";
      const oldText =
        typeof args.old_string === "string" ? args.old_string : "";
      const newText =
        typeof args.new_string === "string" ? args.new_string : "";
      return [
        {
          type: "diff",
          path,
          oldText: oldText || null,
          newText,
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Convert a finalized Autopilot ToolCall into an ACP tool_call SessionUpdate.
 */
export function toAcpToolCall(tc: ToolCall, cwd?: string): AcpToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.function.arguments || "{}");
  } catch {
    console.error(
      `Warning: malformed JSON arguments for tool "${tc.function.name}" (id: ${tc.id}), using empty args`,
    );
  }

  return {
    toolCallId: tc.id,
    title: toolTitle(tc.function.name, args),
    kind: toolKind(tc.function.name),
    status: "in_progress",
    content: toolContent(tc.function.name, args, cwd),
    locations: toolLocations(tc.function.name, args, cwd),
    rawInput: args,
  };
}

/**
 * Convert a Autopilot ToolResult into an ACP tool_call_update SessionUpdate.
 */
export function toAcpToolUpdate(result: ToolResult): ToolCallUpdate {
  const content: ToolCallContent[] = [];

  if (result.content) {
    content.push({
      type: "content",
      content: { type: "text", text: result.content },
    });
  }

  return {
    toolCallId: result.tool_call_id,
    status: result.ok ? "completed" : "failed",
    content: content.length > 0 ? content : undefined,
    rawOutput: result.content,
  };
}

/** The choices shown for an ordinary permission request. */
export function permissionOptions(): PermissionOption[] {
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_session", name: "Allow for this session", kind: "allow_always" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
}

/** The choices for an irreversible action: only ever once, never for the session. */
export function destructivePermissionOptions(): PermissionOption[] {
  return [
    { optionId: "allow_once", name: "Run it (can't be undone)", kind: "allow_once" },
    { optionId: "deny", name: "Don't run it", kind: "reject_once" },
  ];
}

/**
 * Convert the client's answer to Autopilot's decision. A cancelled request
 * (the turn was cancelled, or the client closed the prompt) is a deny. For an
 * irreversible action, an allow is a confirmed one: a person was asked.
 */
export function fromAcpPermissionOutcome(
  outcome: RequestPermissionOutcome,
  opts: { destructive?: boolean } = {},
): PermissionDecisionResult {
  if (outcome.outcome !== "selected") return { decision: "deny", scope: "once" };
  switch (outcome.optionId) {
    case "allow_once":
      return opts.destructive ? { decision: "allow", scope: "once", irreversibleConfirmed: true } : { decision: "allow", scope: "once" };
    case "allow_session":
      return opts.destructive ? { decision: "deny", scope: "once" } : { decision: "allow", scope: "session" };
    default:
      return { decision: "deny", scope: "once" };
  }
}
