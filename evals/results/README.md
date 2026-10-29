# Eval results

Committed summaries of `autopilot-bench` runs. One file per run:
`<YYYY-MM-DD>-<model-slug>.json`, produced by `autopilot eval summarize`
(schema in `../README.md`). Raw `results.jsonl` and traces stay out of git —
they contain absolute local paths and are uploaded as workflow artifacts.

## Baselines

| date | model | config | tasks | success | mean cost | median turns | overflows | file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _none yet_ | | | | | | | | |

The first row is filled in by the first `Eval baseline` workflow run (or a
manual run, see `../README.md`). Until then every harness change is unmeasured;
say so in the PR instead of claiming a win.

## Comparing a change

```sh
autopilot eval run --tasks evals/tasks/autopilot-bench \
  --config evals/configs/baseline.json --model <id> --out /tmp/eval-baseline
autopilot eval run --tasks evals/tasks/autopilot-bench \
  --config evals/configs/<change>.json --model <id> --out /tmp/eval-change
autopilot eval compare /tmp/eval-baseline/results.jsonl /tmp/eval-change/results.jsonl
```

Paste the comparison into the PR body. Keep the change only when success is
not significantly worse and the cost/turn numbers justify it.
