/**
 * A line diff as Claude Code's `structuredPatch`: hunks of
 * `{ oldStart, oldLines, newStart, newLines, lines }`, where each line is
 * the text prefixed with " " (context), "-" (removed) or "+" (added), with
 * no trailing newline, and 3 lines of context (the jsdiff
 * `structuredPatch` shape Claude Code sends on Edit / Write hooks).
 *
 * Common leading and trailing lines are trimmed first, then the middle is
 * diffed with Myers' algorithm; a middle too large for that (see
 * MAX_MYERS_COST) is reported as one replaced block, which is still a
 * correct patch, only less minimal.
 */

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

type Op = { kind: " " | "-" | "+"; text: string };

const DEFAULT_CONTEXT = 3;
/** Above this (old lines + new lines) × edit distance bound, skip Myers. */
const MAX_MYERS_COST = 4_000_000;

/** Split into lines without their terminators; a final newline ends the last line rather than starting an empty one. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers' O((N+M)·D) shortest edit script over two line arrays. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if ((n + m) * d > MAX_MYERS_COST) return null;
    trace.push(v.slice());
    const next = v;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && next[offset + k - 1]! < next[offset + k + 1]!)) x = next[offset + k + 1]!;
      else x = next[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(next.slice());
        return backtrack(trace, a, b, offset);
      }
    }
    v = next;
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  // trace[d] holds V before step d; the last entry is V after the final step.
  for (let d = trace.length - 2; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", text: a[x - 1]! });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ kind: "+", text: b[y - 1]! });
    else ops.push({ kind: "-", text: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: " ", text: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

function editScript(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const mid = myers(midA, midB) ?? [
    ...midA.map((text): Op => ({ kind: "-", text })),
    ...midB.map((text): Op => ({ kind: "+", text })),
  ];
  return [
    ...a.slice(0, pre).map((text): Op => ({ kind: " ", text })),
    ...mid,
    ...a.slice(a.length - suf).map((text): Op => ({ kind: " ", text })),
  ];
}

/** Claude Code-style `structuredPatch` from `oldText` to `newText`. Empty when they have the same lines. */
export function structuredPatch(oldText: string, newText: string, context = DEFAULT_CONTEXT): PatchHunk[] {
  const ops = editScript(splitLines(oldText), splitLines(newText));
  const hunks: PatchHunk[] = [];
  // Old/new line numbers (1-based) of each op.
  let oldNo = 1;
  let newNo = 1;
  const pos = ops.map((op) => {
    const at = { old: oldNo, new: newNo };
    if (op.kind !== "+") oldNo++;
    if (op.kind !== "-") newNo++;
    return at;
  });
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === " ") {
      i++;
      continue;
    }
    // A change at i: open a hunk with up to `context` lines before it.
    const start = Math.max(0, i - context);
    let end = i;
    // Extend while the next change is within 2×context unchanged lines.
    for (;;) {
      while (end < ops.length && ops[end]!.kind !== " ") end++;
      let gap = end;
      while (gap < ops.length && ops[gap]!.kind === " ") gap++;
      if (gap < ops.length && gap - end <= 2 * context) {
        end = gap;
        continue;
      }
      end = Math.min(ops.length, end + context);
      break;
    }
    const slice = ops.slice(start, end);
    const oldLines = slice.filter((o) => o.kind !== "+").length;
    const newLines = slice.filter((o) => o.kind !== "-").length;
    const first = pos[start]!;
    hunks.push({
      // jsdiff's convention: a hunk with no old (or new) lines starts one line earlier.
      oldStart: oldLines === 0 ? first.old - 1 : first.old,
      oldLines,
      newStart: newLines === 0 ? first.new - 1 : first.new,
      newLines,
      lines: slice.map((o) => o.kind + o.text),
    });
    i = end;
  }
  return hunks;
}
