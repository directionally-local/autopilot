import { randomUUID } from "node:crypto";
import { createParallelSearchPermit, PARALLEL_MCP_URL, type ParallelSearchPermit } from "../tools/parallel-search.js";

const USAGE = 'Use /search parallel-public-docs {"objective":"Find the public Node.js readFile documentation","search_queries":["Node.js fs readFile documentation"]}. Only enter text you authorize sending publicly. Review the preview, then /search approve <token>; /search cancel discards it.';

/** Terminal input only. Previews and approval tokens never enter model history,
 * session files, config, or the tool registry. */
export function createForegroundSearchChoice() {
  let pending: { token: string; objective: string; search_queries: [string] } | undefined;
  return {
    clear() { pending = undefined; },
    command(raw: string): { notice: string; permit?: ParallelSearchPermit } {
      const approval = /^approve ([\w-]+)$/.exec(raw);
      if (approval) {
        const preview = pending;
        pending = undefined;
        if (!preview || approval[1] !== preview.token) return { notice: "No matching public-documentation preview. Prepare a new /search lookup." };
        return { notice: "Approved one exact public-documentation lookup for this foreground turn.", permit: createParallelSearchPermit(preview) };
      }
      pending = undefined;
      if (raw === "cancel") return { notice: "Public-documentation lookup cancelled." };
      if (!raw.startsWith("parallel-public-docs ")) return { notice: USAGE };
      try {
        const input: unknown = JSON.parse(raw.slice("parallel-public-docs ".length));
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
        const fields = input as Record<string, unknown>;
        const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 1000 && !/[\x00-\x1f\x7f]/.test(v);
        if (Object.keys(fields).length !== 2 || !text(fields.objective) || !Array.isArray(fields.search_queries) || fields.search_queries.length !== 1 || !text(fields.search_queries[0])) throw new Error();
        pending = { token: randomUUID(), objective: fields.objective, search_queries: [fields.search_queries[0]] };
        const args = { objective: pending.objective, search_queries: pending.search_queries };
        return { notice: `Parallel public-documentation lookup preview\nDestination: ${PARALLEL_MCP_URL}\nMCP tool: web_search\nExact outbound tool arguments:\n${JSON.stringify(args, null, 2)}\nNo conversation, files, credentials, model identity, or prior search session are included.\nBy typing /search approve ${pending.token}, you confirm this text is public documentation search text and authorize this exact lookup once. Any other input discards the preview.` };
      } catch {
        return { notice: `Enter exactly an objective and one search_queries string (1–1000 characters each; no control characters). ${USAGE}` };
      }
    },
  };
}
