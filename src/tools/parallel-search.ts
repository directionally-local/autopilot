import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAppVersion, getUserAgent } from "../util/version.js";
import type { ToolContext, ToolOutput } from "./registry.js";

export const PARALLEL_MCP_URL = "https://mcp.parallel.ai/mcp";
const TIMEOUT_MS = 15_000;

/** An ephemeral host callback, forwarded only by the foreground dispatcher. */
export interface ForegroundSearch {
  readonly query: string;
  close(): void;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ParallelSearchPermit {
  readonly objective: string;
  bind(signal: AbortSignal): ForegroundSearch;
}

/** Called only after affirmative terminal approval of an exact preview.
 * The stored strings, never model arguments, supply the outbound request. */
export function createParallelSearchPermit(input: { objective: string; search_queries: readonly [string] }): ParallelSearchPermit {
  const objective = input.objective;
  const searchQueries = Object.freeze([input.search_queries[0]]);
  const approvedArguments = JSON.stringify({ objective, search_queries: searchQueries });
  let bound = false;
  let consumed = false;
  return Object.freeze({
    objective,
    bind(signal: AbortSignal): ForegroundSearch {
      if (bound) throw new Error("Public-documentation permit is already bound to a turn.");
      bound = true;
      const lifetime = new AbortController();
      return Object.freeze({
        query: objective,
        close() { lifetime.abort(); },
        async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
          if (ctx.signal !== signal || signal.aborted || lifetime.signal.aborted || ctx.runId || ctx.codeModeParentToolCallId) throw new Error("Public-documentation permit requires its original active foreground turn.");
          if (Object.keys(args).length !== 1 || args.query !== objective) throw new Error("Only the exact approved public-documentation query is permitted; no additional fields.");
          if (consumed) throw new Error("Public-documentation permit has already been consumed.");
          const timeout = AbortSignal.timeout(TIMEOUT_MS);
          const requestSignal = AbortSignal.any([signal, lifetime.signal, timeout]);
          const client = new Client({ name: "autopilot", version: getAppVersion() });
          const transport = new StreamableHTTPClientTransport(new URL(PARALLEL_MCP_URL), {
            fetch: async (url, init) => {
              // Enforce the permit again at I/O. SDK retries, alternate callers,
              // and generic auto-approval cannot mint another query allowance.
              if (String(url) !== PARALLEL_MCP_URL) throw new Error("Unexpected Parallel destination.");
              if (requestSignal.aborted) throw new Error("Public-documentation turn ended or timed out.");
              // This one-shot client does not open an unsolicited event stream.
              if (init?.method === "GET") return new Response(null, { status: 405 });
              const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
              if (body?.method === "tools/call") {
                const params = body.params as { name?: unknown; arguments?: unknown } | undefined;
                if (consumed || params?.name !== "web_search" || JSON.stringify(params.arguments) !== approvedArguments) throw new Error("Parallel request does not match an unused public-documentation permit.");
                consumed = true;
              } else if (body?.method !== "initialize" && body?.method !== "notifications/initialized" && init?.method !== "DELETE") {
                throw new Error("Unexpected Parallel protocol request.");
              }
              const headers = new Headers(init?.headers);
              headers.set("User-Agent", getUserAgent());
              return fetch(url, { ...init, signal: requestSignal, redirect: "error", headers });
            },
          });
          try {
            await client.connect(transport, { signal: requestSignal, timeout: TIMEOUT_MS });
            const result = await client.callTool({ name: "web_search", arguments: JSON.parse(approvedArguments) as Record<string, unknown> }, undefined, { signal: requestSignal, timeout: TIMEOUT_MS });
            if (result.isError) throw new Error("Parallel web_search returned a tool error.");
            const content = Array.isArray(result.content)
              ? result.content.filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text as string).join("\n")
              : "";
            const text = content.trim() ? content : `No results found for "${objective}".`;
            const bytes = Buffer.byteLength(text, "utf8");
            return { content: text, rawBytes: bytes, reducedBytes: bytes };
          } finally {
            // A failed or unavailable request also spends this approval.
            consumed = true;
            await client.close().catch(() => undefined);
          }
        },
      });
    },
  });
}
