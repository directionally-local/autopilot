/**
 * Classify a shell command as a verification step (test, lint, typecheck,
 * build) so its exit code can be recorded as an `outcome{verification}`.
 * Regex table, no shell parsing: a runner counts only at the start of a
 * command segment (after `;`, `&&`, `|`, env assignments, or an `npx`-style
 * shim), so `cat jest.config.js` is not a test run. Tests win over build.
 */

import type { VerificationCategory } from "./types.js";

/** Start of a command segment, optionally preceded by env assignments and a runner shim. */
const SEG = String.raw`(?:^|[;|(]\s*|&&\s*|\|\|\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+|pnpm\s+exec\s+|pnpm\s+dlx\s+|yarn\s+|bunx\s+|bun\s+run\s+|(?:\.\/)?node_modules\/\.bin\/)?`;

function segment(alternatives: string): RegExp {
  return new RegExp(`${SEG}(?:${alternatives})(?:\\s|$)`);
}

const TABLE: Array<[VerificationCategory, RegExp]> = [
  [
    "test",
    segment(String.raw`npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|tsx\s+--test|node\s+--test|vitest|jest|pytest|go\s+test|cargo\s+test`),
  ],
  ["lint", segment(String.raw`eslint|ruff|golangci-lint|npm\s+run\s+lint|pnpm\s+(?:run\s+)?lint|yarn\s+(?:run\s+)?lint`)],
  ["typecheck", segment(String.raw`tsc|mypy|pyright|npm\s+run\s+typecheck|pnpm\s+(?:run\s+)?typecheck|yarn\s+(?:run\s+)?typecheck`)],
  ["build", segment(String.raw`npm\s+run\s+build|tsup|cargo\s+build|go\s+build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build`)],
];

/** The verification category of `command`, or null when it is not one. */
export function classifyVerification(command: string): VerificationCategory | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  for (const [category, re] of TABLE) {
    if (re.test(trimmed)) return category;
  }
  return null;
}
