import { platform } from "node:os";
import type { HookConfig, HookEvent } from "./types.js";

/**
 * Curated, pre-built hooks shipped as opt-in starters. Listed here,
 * `/hooks recommended` shows them, `/hooks enable <id>` appends the
 * chosen one to the project (or global) settings.json with
 * `enabled: true`.
 *
 * Conventions:
 *   - Every entry has a stable, human-readable `id`.
 *   - All entries are filtered to the platforms they actually work on
 *     (e.g. the macOS notification hook is excluded from Linux runs).
 *   - Commands are deliberately defensive: `|| true` after best-effort
 *     fallbacks, exit codes that don't surprise.
 *
 * Why most are disabled-by-default in this catalog: because we don't
 * know the user's intent. The catalog seeds discovery; the user
 * decides what to wire up.
 */

export interface RecommendedHook {
  id: string;
  event: HookEvent;
  hook: HookConfig;
}

const isMac = platform() === "darwin";

export const RECOMMENDED_HOOKS: RecommendedHook[] = [
  // ── Stop notifications ───────────────────────────────────────────────
  {
    id: "stop-bell",
    event: "Stop",
    hook: {
      id: "stop-bell",
      command: "printf '\\a'",
      enabled: false,
      description: "Terminal bell when the agent finishes a turn. Works everywhere.",
    },
  },
  ...(isMac
    ? [
        {
          id: "stop-notify-macos",
          event: "Stop" as HookEvent,
          hook: {
            id: "stop-notify-macos",
            command:
              "osascript -e 'display notification \"Turn complete\" with title \"kimiflare\"'",
            enabled: false,
            description: "macOS desktop notification when the agent finishes.",
          },
        },
        {
          id: "stop-glass-sound-macos",
          event: "Stop" as HookEvent,
          hook: {
            id: "stop-glass-sound-macos",
            command: "afplay /System/Library/Sounds/Glass.aiff",
            enabled: false,
            description: "Play the Glass sound on macOS when the agent finishes.",
          },
        },
      ]
    : []),

  // ── PreToolUse guards (blocking: exit 2, reason on stderr) ───────────
  {
    id: "block-env-file-writes",
    event: "PreToolUse",
    hook: {
      id: "block-env-file-writes",
      matcher: "^(edit|write)$",
      command:
        'case "$KIMIFLARE_HOOK_PATH" in *.env|.env.*|*secrets*|*.pem|*.key) ' +
        'echo "blocked: paths matching .env / secrets / *.pem are off-limits" >&2; exit 2;; esac',
      enabled: false,
      description:
        "Block edit/write to .env, secrets, *.pem, and *.key files. Vetoes the call; the model sees the rejection reason.",
    },
  },
  {
    id: "block-git-internals",
    event: "PreToolUse",
    hook: {
      id: "block-git-internals",
      matcher: "^(edit|write)$",
      command:
        'case "$KIMIFLARE_HOOK_PATH" in *.git/*|.git/*) ' +
        'echo "blocked: cannot edit files inside .git/" >&2; exit 2;; esac',
      enabled: false,
      description:
        "Block edit/write to anything inside .git/. Use a real git command instead.",
    },
  },

  // ── PostToolUse: lint / format ───────────────────────────────────────
  {
    id: "post-edit-prettier",
    event: "PostToolUse",
    hook: {
      id: "post-edit-prettier",
      matcher: "^(edit|write)$",
      // Run only when prettier exists locally; never block the agent
      // on a missing dev dep.
      command:
        'command -v npx >/dev/null 2>&1 || exit 0; ' +
        'case "$KIMIFLARE_HOOK_PATH" in *.ts|*.tsx|*.js|*.jsx|*.json|*.md|*.css|*.html) ' +
        'npx --no-install prettier --write "$KIMIFLARE_HOOK_PATH" >/dev/null 2>&1 || true ;; ' +
        'esac',
      enabled: false,
      description:
        "Auto-format JS/TS/JSON/MD/CSS/HTML files with prettier after edit. Silent no-op if prettier isn't installed.",
    },
  },

  // ── PostToolUse: audit trail ─────────────────────────────────────────
  {
    id: "audit-tool-calls",
    event: "PostToolUse",
    hook: {
      id: "audit-tool-calls",
      command:
        'mkdir -p ~/.local/state/kimiflare && ' +
        'printf "%s\\t%s\\t%s\\t%s\\n" ' +
        '"$(date -u +%Y-%m-%dT%H:%M:%SZ)" ' +
        '"$KIMIFLARE_HOOK_SESSION_ID" ' +
        '"$KIMIFLARE_HOOK_TOOL" ' +
        '"$KIMIFLARE_HOOK_RESULT_OK" ' +
        '>> ~/.local/state/kimiflare/tool-audit.log',
      enabled: false,
      description:
        "Append every tool call (timestamp / session / tool / ok) to ~/.local/state/kimiflare/tool-audit.log.",
    },
  },
];

/**
 * Commands that earlier releases wrote for the recommended PreToolUse
 * guards. They blocked with `exit 1`, which now fails open, so the loader
 * swaps them for the current `exit 2` command when it finds one verbatim
 * in a settings file. Keyed by the old command string.
 */
export const LEGACY_RECOMMENDED_COMMANDS: ReadonlyMap<string, string> = new Map([
  [
    'case "$KIMIFLARE_HOOK_PATH" in *.env|.env.*|*secrets*|*.pem|*.key) ' +
      'echo "blocked: paths matching .env / secrets / *.pem are off-limits"; exit 1;; esac',
    getRecommendedHook("block-env-file-writes")!.hook.command,
  ],
  [
    'case "$KIMIFLARE_HOOK_PATH" in *.git/*|.git/*) ' + 'echo "blocked: cannot edit files inside .git/"; exit 1;; esac',
    getRecommendedHook("block-git-internals")!.hook.command,
  ],
]);

/** Look up a recommended hook by id. */
export function getRecommendedHook(id: string): RecommendedHook | undefined {
  return RECOMMENDED_HOOKS.find((r) => r.id === id);
}
