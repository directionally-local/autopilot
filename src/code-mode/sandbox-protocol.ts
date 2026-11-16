/**
 * Messages between the parent (src/code-mode/sandbox.ts) and the Code Mode
 * sandbox host (src/code-mode/sandbox-host.ts), sent over the child process's
 * IPC channel. Types only: the host imports this with `import type`, so it
 * stays a self-contained script Node can run without a bundler or loader.
 */

/** Test-only fault injection, honoured only when the parent enabled test hooks. */
export type SandboxHostTestHook = "segv" | "abort" | "sigkill" | "exit1" | "env";

export type ParentToHost =
  | {
      type: "run";
      runId: number;
      /** JavaScript, already transpiled by the parent. */
      code: string;
      toolNames: string[];
      timeoutMs: number;
      memoryLimitMB: number;
      testHook?: SandboxHostTestHook;
    }
  | { type: "toolResult"; runId: number; callId: number; content?: string; error?: string };

export type HostToParent =
  | { type: "ready"; pid: number; node: string; isolatedVm: string | null }
  | { type: "log"; runId: number; line: string }
  | { type: "tool"; runId: number; callId: number; name: string; argsJson: string }
  | { type: "done"; runId: number; error?: string };
