# Evals

Headless, matched evaluation of Autopilot against itself (plan: `docs/plans/trace-and-dataset-dev-plan.md`, Phase 4).

```
autopilot eval run --tasks evals/tasks/autopilot-bench --config evals/configs/baseline.json --model <id> --samples 1 --out /tmp/eval-baseline
autopilot eval run --tasks evals/tasks/autopilot-bench --config evals/configs/<change>.json  --model <id> --samples 1 --out /tmp/eval-change
autopilot eval compare /tmp/eval-baseline/results.jsonl /tmp/eval-change/results.jsonl
```

`eval run` creates a detached git worktree per task × sample at the task's `base_commit`, copies the task's `files` in, runs `setup`, drives the agent through the SDK with permissions auto-approved and tracing forced on (`<out>/traces/<session>/`), restores `files`, runs `test`, records `outcome{test_verdict}` on the trace, and appends one line to `<out>/results.jsonl`. Harness failures (crash, timeout, setup failure) are recorded as `passed: false` with an `error`; one task never aborts the set. `--concurrency K` runs K tasks at once; `--filter <glob>` selects task ids; `--keep` leaves worktrees under `<out>/work/`.

`eval compare` collapses samples to one outcome per task (strict majority), pairs tasks present in both files, and prints success rates, an exact two-sided McNemar test on the discordant pairs, mean and median cost, median turns, overflow counts, and the per-task flips.

## Task format

`evals/tasks/<set>/<task_id>.json`:

| field | meaning |
| --- | --- |
| `id` | must equal the file name |
| `repo` | git URL (cloned once into `<out>/cache/`) or absolute path (used as the worktree source directly) |
| `base_commit` | commit the worktree is created at |
| `prompt` | what the agent is asked to do |
| `setup` | shell, run once in the worktree before the agent (install deps); optional |
| `test` | shell; exit 0 = pass; run after the agent |
| `timeout_s` | wall clock for setup, agent, and test each; default 1800 |
| `tags` | free-form |
| `files` | `{ "<path in worktree>": "<path relative to the set dir>" }`, copied in before the agent and again before `test`, so the agent can read the spec but cannot change what is verified |

## Harness configs

`evals/configs/<name>.json`: `{ "name", "model"?, "temperature"?, "config": <partial KimiConfig> }`. `config` is merged over the user's own config for every run; `--model` overrides `model`. `baseline.json` is today's defaults. Add one file per harness change so both arms of a comparison differ in exactly that change. The merged, redacted config is written to `<out>/config.json` and into every trace's `session_start`.

## autopilot-bench

Twenty tasks mined from this repository's merged pull requests. Each task is a PR that changed source and added or changed a test: the worktree starts at the PR's base commit, the PR's test file(s) at the merge commit are placed in the worktree (`files/<task_id>/...`), the prompt is the PR description rewritten as a task, and `test` runs those files with `npx tsx --test`. Every test fails at the base commit and passes at the merge commit.

### Recipe for adding a task

1. Pick a merged PR that touched at least one `*.test.ts`/`*.test.tsx` and at least one non-test source file, with a modest diff.
2. `merge=$(gh pr view <n> --json mergeCommit --jq .mergeCommit.oid)`; `base=$(git rev-parse "$merge^1")`.
3. `tests=$(git diff --name-only "$base" "$merge" | grep -E '\.test\.tsx?$')`; for each, `git show "$merge:$t" > evals/tasks/autopilot-bench/files/<task_id>/$t`.
4. Confirm the task is well-posed: in a worktree at `$base` with the test files copied in, `npx tsx --test $tests` must fail.
5. Write `<task_id>.json` with `base_commit: $base`, `files` mapping each test path to its copy, `setup: "npm ci --no-audit --no-fund"`, `test: "npx tsx --test $tests"`, and a prompt that describes the behaviour the PR delivered (from its description) without pasting the diff. Tell the agent the tests are in the worktree and must not be modified.

SWE-Bench and Terminal-Bench adapters are follow-ups (plan §6).
