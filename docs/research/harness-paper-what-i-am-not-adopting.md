# What I'm not taking from the coding-agent harness paper, and why

*A note on arXiv:2609.20804, "An Empirical Study of Harness Design for Coding Agents" (Fan et al., Sept 2026), from the perspective of someone who builds and daily-drives a terminal coding agent ([Autopilot](https://github.com/sinameraji/autopilot)).*

This is a good paper. It holds the agent loop fixed and ablates three harness components, one at a time, across 176 matched settings, four models, and context budgets from 32k to 128k, on SWE-Bench Verified and Terminal-Bench 2.1. Its headline results are worth repeating: context management mostly prevents overflow and matters less as windows grow; stubbing stale tool outputs before you ever summarize is the cheapest policy; a "recall the elided output" tool is almost never used; planning helps weak models and only cuts cost for strong ones; and strong models did better and cheaper with bash alone, while weak models needed structured tools.

I'm adopting several things from it: staged elision before summarization, context thresholds that scale with the window, post-edit diagnostics appended to edit results, a read-before-write check, and above all the method, matched ablations with trajectory-level phase labels. Here is what I'm **not** adopting, and why.

## 1. Bash-only as the action space for strong models

The paper's strongest model was 53% cheaper and a few points more accurate with bash alone. The mechanism they identify is bundling: one command does what used to take five tool calls.

I'm keeping structured tools. Three reasons. First, the paper's harness is non-interactive. In a tool you run on your own repo, structured `edit` and `write` are what give you diff previews, read-before-write checks, and per-file permission prompts. Bash-only throws that away, and the paper says as much: their bash-only arm also lost state tracking and automatic diagnostics. Second, the effect is not stable. Their cross-family model flipped sign by benchmark (+23 points with tools on SWE-Bench, +7 with bash on Terminal-Bench). Third, you can get the bundling without the loss. Autopilot's Code Mode lets the model write one sandboxed program that calls read, grep, glob, and bash together, and only the program's printed output enters the context. That is the same win with the guardrails intact.

## 2. LLM summarization as the backbone of context management

Their summarizer is a separate call to the model under evaluation, every time history crosses a threshold. The paper's own cost result for its best tier comes from firing that call less often.

I'm going one step further and keeping it off by default. Autopilot's compaction is rule-based: it folds older turns into a structured state block (files touched, tasks, recent failures) with no model call, no latency, and no cost. Elision before summarization is a good idea and I'm adding it. Summarization itself stays an opt-in fallback.

## 3. Tail-truncating tool output at 24k characters

The paper caps each tool result at 24k chars and relies on later elision to clean up. Until a result goes stale, a noisy test log costs 24k tokens on every single request.

Autopilot reduces at write time instead: it extracts the error block from a failed command, dedupes repeated lines, caps grep matches per file, and returns an outline of a large file rather than its head. Fresh observations are small from the first request, and the part that survives is the informative part. I will experiment with larger caps now that stale outputs can be stubbed, but with a rollback, not as a planned loosening.

## 4. Always-on plan re-injection

The paper re-injects the plan before every turn and nags the model to plan first. For the weakest model that was worth 11.6 points, mostly by stopping runs that quit before making an edit. For strong models it bought no accuracy, only a cost cut from trimming redundant verification.

I'm not making it universal. Autopilot already catches the "ended without doing the work" failure with a single small check at the end of a turn, skipped on trivial requests, which is far less per-turn overhead than a plan reminder on every request. And if the real win for strong models is fewer redundant test runs, I'd rather target that directly with a verification-budget nudge than pay for planning machinery to get it as a side effect. The plan tool stays, lighter, and gated by how hard the task looks.

## 5. The paper's stuck-detection thresholds

Reminder after five identical calls, terminate after eight identical failures. Autopilot blocks on the third identical call, allows one recovery, then stops. That is two to five fewer wasted calls per spin. The paper tested its thresholds as fixed substrate, not as a variable, so there is no evidence to loosen.

## 6. Cost accounting that ignores prompt caching

Their models were served locally and costs were raw token prices. No prompt caching. Every cost argument in the paper about large tool sets or per-turn reminders assumes you pay full price for the prefix every request. On OpenRouter with frontier models you don't: a stable system prompt and tool list is mostly cached tokens. The remaining cost of a big tool set is model confusion, which is a real thing to measure, but it isn't the number in the paper.

## 7. One harness configuration per run

The paper's own conclusion is that components should be chosen per model, task, and budget. Its harness can't do that; it is configured once per benchmark run. The interesting version of that conclusion is per-turn adaptivity: classify how hard the request looks and switch the expensive machinery on only when it pays. Autopilot does a crude version of this already. That is the direction, not a static profile table.

## 8. Single-shot benchmarks as the quality bar

Most of the paper's failed runs died in the localization phase, before the first edit. Nothing in a single-shot Python benchmark rewards the things that attack localization in real use: a project context file, cross-session memory of where things live, a language server, and the fact that you've used the tool on this repo before. Those don't show up in SWE-Bench and they are a large part of why a daily-driven agent feels good. I'll keep building an eval, but on tasks from my own repo's history alongside the public ones.

## The honest caveat

None of my "Autopilot does this better" claims are measured yet. The paper's real gift is the method. The next step is a headless, matched evaluation of Autopilot against itself, so that every one of these choices gets the same scrutiny the paper gave its own.
