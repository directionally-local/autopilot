/**
 * Attach mode: connect to a running autopilot serve instance
 * and stream the response to stdout.
 */

import type { PrintFormat } from "./print-mode.js";
import { PROMPT_BLOCKED_EXIT_CODE } from "./hooks/prompt-submit.js";

export interface AttachModeOpts {
  attachUrl: string;
  prompt: string;
  model?: string;
  files?: string[];
  format?: PrintFormat;
  allowAll?: boolean;
  sessionId?: string;
}

export async function runAttachMode(opts: AttachModeOpts): Promise<void> {
  const url = opts.attachUrl.replace(/\/$/, "");
  const format = opts.format ?? "text";

  // If we have a sessionId, send follow-up; otherwise start new session
  const endpoint = opts.sessionId
    ? `${url}/session/${opts.sessionId}/prompt`
    : `${url}/prompt`;

  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    allowAll: opts.allowAll ?? false,
  };
  if (opts.model) body.model = opts.model;
  if (opts.files) body.files = opts.files;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    console.error(`kimiflare attach: ${response.status} ${text}`);
    // 403 prompt_blocked: a UserPromptSubmit hook on the server blocked it.
    process.exit(response.status === 403 && text.includes('"prompt_blocked"') ? PROMPT_BLOCKED_EXIT_CODE : 1);
  }

  const result = (await response.json()) as { sessionId: string; status: string };
  const sessionId = result.sessionId;

  if (format === "json") {
    // For JSON format, we need to collect the full output.
    // Connect to SSE and accumulate.
    await streamSseJson(url, sessionId);
  } else {
    // text or stream-json: stream directly
    await streamSse(url, sessionId, format);
  }
}

async function streamSse(url: string, sessionId: string, format: PrintFormat): Promise<void> {
  const eventSource = new EventSource(`${url}/event`);
  let done = false;

  return new Promise((resolve, reject) => {
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === "server.connected") return;

        switch (data.event) {
          case "assistant.delta":
            if (format === "text") {
              process.stdout.write(data.delta);
            } else if (format === "stream-json") {
              process.stdout.write(JSON.stringify({ event: "text_delta", delta: data.delta }) + "\n");
            }
            break;
          case "tool.call":
            if (format === "text") {
              process.stderr.write(`\x1b[2m[tool ${data.name}(${JSON.stringify(data.arguments)})]\x1b[0m\n`);
            } else if (format === "stream-json") {
              process.stdout.write(JSON.stringify({ event: "tool_call", id: data.id, name: data.name, arguments: data.arguments }) + "\n");
            }
            break;
          case "tool.result":
            if (format === "text") {
              const snippet = data.content.length > 400 ? data.content.slice(0, 400) + "..." : data.content;
              process.stderr.write(`\x1b[2m[result: ${snippet.replace(/\n/g, " ⏎ ")}]\x1b[0m\n`);
            } else if (format === "stream-json") {
              process.stdout.write(JSON.stringify({ event: "tool_result", toolCallId: data.toolCallId, name: data.name, content: data.content, ok: data.ok }) + "\n");
            }
            break;
          case "usage.update":
            if (format === "stream-json") {
              process.stdout.write(JSON.stringify({ event: "usage", promptTokens: data.promptTokens, completionTokens: data.completionTokens, totalTokens: data.totalTokens }) + "\n");
            }
            break;
          case "warning":
            if (format === "text") {
              process.stderr.write(`\x1b[33mkimiflare: ${data.message}\x1b[0m\n`);
            } else if (format === "stream-json") {
              process.stdout.write(JSON.stringify({ event: "warning", message: data.message }) + "\n");
            }
            break;
          case "session.completed":
            done = true;
            eventSource.close();
            if (format === "text") process.stdout.write("\n");
            resolve(undefined);
            break;
          case "error":
            done = true;
            eventSource.close();
            if (format === "text") {
              process.stderr.write(`\n\x1b[31mError: ${data.message}\x1b[0m\n`);
            } else if (format === "stream-json") {
              process.stdout.write(JSON.stringify({ event: "error", message: data.message }) + "\n");
            }
            process.exitCode = 1;
            resolve(undefined);
            break;
        }
      } catch {
        // ignore malformed events
      }
    };

    eventSource.onerror = () => {
      if (!done) {
        eventSource.close();
        reject(new Error("SSE connection failed"));
      }
    };

    // Timeout safety
    setTimeout(() => {
      if (!done) {
        eventSource.close();
        reject(new Error("SSE stream timed out after 10 minutes"));
      }
    }, 600_000);
  });
}

async function streamSseJson(url: string, sessionId: string): Promise<void> {
  // Accumulate events and output final JSON
  const text: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  const toolResults: Array<{ toolCallId: string; name: string; content: string; ok: boolean }> = [];
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

  const eventSource = new EventSource(`${url}/event`);

  return new Promise((resolve, reject) => {
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === "server.connected") return;

        switch (data.event) {
          case "assistant.delta":
            text.push(data.delta);
            break;
          case "tool.call":
            toolCalls.push({ id: data.id, name: data.name, arguments: data.arguments });
            break;
          case "tool.result":
            toolResults.push({ toolCallId: data.toolCallId, name: data.name, content: data.content, ok: data.ok });
            break;
          case "usage.update":
            usage = {
              promptTokens: data.promptTokens,
              completionTokens: data.completionTokens,
              totalTokens: data.totalTokens,
            };
            break;
          case "session.completed":
            eventSource.close();
            process.stdout.write(
              JSON.stringify(
                {
                  text: text.join(""),
                  toolCalls,
                  toolResults,
                  usage,
                  sessionId,
                },
                null,
                2,
              ) + "\n",
            );
            resolve(undefined);
            break;
          case "error":
            eventSource.close();
            process.stdout.write(
              JSON.stringify({ error: data.message, sessionId }, null, 2) + "\n",
            );
            process.exitCode = 1;
            resolve(undefined);
            break;
        }
      } catch {
        // ignore
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      reject(new Error("SSE connection failed"));
    };

    setTimeout(() => {
      eventSource.close();
      reject(new Error("SSE stream timed out after 10 minutes"));
    }, 600_000);
  });
}

// Minimal EventSource polyfill for Node.js
class EventSource {
  private url: string;
  private controller: AbortController;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.controller = new AbortController();
    this.start();
  }

  private async start(): Promise<void> {
    try {
      const response = await fetch(this.url, {
        signal: this.controller.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!response.ok || !response.body) {
        this.onerror?.();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentData = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "" && currentData) {
            this.onmessage?.({ data: currentData });
            currentData = "";
          }
        }
      }
    } catch {
      this.onerror?.();
    }
  }

  close(): void {
    this.controller.abort();
  }
}
