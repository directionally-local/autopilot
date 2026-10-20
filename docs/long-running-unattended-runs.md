# Long-running unattended runs

Autopilot's headless server can coordinate work that lasts much longer than one model turn. The agent starts a managed job, yields with `wait_for`, and is invoked again when the job finishes or a timer fires. It does not keep an LLM request open while the job runs.

## Start a run

Set a server password and run the headless server under a service manager (for example, systemd or launchd):

```sh
KIMIFLARE_SERVER_PASSWORD='use-a-secret' autopilot serve
```

The server defaults to listening on localhost. If you expose it beyond the machine, use TLS and protect it with the configured Basic Auth password.

Create a task through the authenticated API. For work that does not need an isolated Git worktree, set `worktree` to false. Only tools in `allowedTools` are available to the run; `wait_for` is always added automatically.

```sh
curl -u "kimiflare:$KIMIFLARE_SERVER_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Run the training job, inspect its checkpoints and health periodically, and report when it completes or needs intervention.",
    "cwd": "/workspace/model-training",
    "worktree": false,
    "allowedTools": ["job_start", "job_status", "job_logs", "job_cancel"]
  }' \
  http://127.0.0.1:4096/runs
```

New runs have **no overall runtime, cumulative token, cost, or tool-action budget by default**. Autopilot still accounts for usage. A model turn remains bounded by the agent's per-turn iteration and loop guardrails; those limits do not accumulate across separate check-ins. Provider rate limits, API availability, and machine resources still apply.

To opt into a hard budget, pass any of `maxRuntimeMs`, `maxTotalTokens`, `maxCostUsd`, or `maxToolIterations`. The runtime and tool-action budgets apply to the whole run, including time spent waiting. Send `null` for any field to leave that budget unlimited. Numeric limits are validated as safe positive values (cost must be at least $0.01); there is no seven-day run ceiling or fixed upper budget in Autopilot.

## Keep a job running and check in

Use `job_start` for a detached command and then yield rather than polling the model continuously:

```text
job_start({ command: "python train.py --checkpoint-every 10m", idempotency_key: "training-run-1" })
wait_for({ job_id: "<job-id>", poll_interval_ms: 300000 })
```

A managed job's `timeout_ms` is optional. If supplied, its maximum is seven days; omit it when the job should have no Autopilot-enforced wall-clock timeout. Job output is appended to log files and can be read with `job_logs`. Job waiting is checked on a durable timer; checks reschedule while the job remains active. A single timer or `wait_for` interval is at most seven days, but repeated checks can continue for the lifetime of the run.

`job_start` is **not** an interactive shell/PTY: stdin is closed and Autopilot cannot send later keystrokes to that same shell. It is appropriate for a command that manages itself (such as a training program with checkpoints). Use an external job scheduler if the workload needs an interactive control channel, GPU allocation, cluster placement, or infrastructure-level retries.

## Budget pauses and resumption

If an explicitly configured run budget is reached (or cost enforcement is impossible because the provider did not report authoritative cost), Autopilot changes the run to `needs_input` instead of marking the task completed or failed. The background job is not automatically killed: it is separate from the agent. Inspect the run, job, and usage, then resume with a revised limit or remove it with `null`:

```sh
curl -u "kimiflare:$KIMIFLARE_SERVER_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d '{"maxRuntimeMs": null, "maxTotalTokens": null}' \
  -X POST http://127.0.0.1:4096/runs/<run-id>/resume
```

The resume request must update at least one budget. Omitted fields keep their current values. The saved session gets a continuation note and the agent resumes from that checkpoint.

### When the current turn outgrows the model's context

An unattended run can work for hours on one task without a new user message, so its single turn keeps growing. Older turns are compacted, but the active turn is kept word for word. If it alone no longer fits the model's context window, the run moves to `needs_input` (it does not fail) with a stop reason like:

```text
context_budget_exceeded: the current turn needs ~215,000 tokens but moonshotai/kimi-k2.6 has 120,000 available (context window 128,000); older turns are already compacted. Resume with a larger-context model ({"model": "<id>"}) or cancel the run.
```

Connected clients also receive a `run.needs_input` event. Continue on a model with a larger window, or cancel:

```sh
curl -u "kimiflare:$KIMIFLARE_SERVER_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d '{"model": "google/gemini-3.8-flash"}' \
  -X POST http://127.0.0.1:4096/runs/<run-id>/resume
```

A resume may change the model, the budgets, or both.

## Email notifications

Autopilot can email you when an unattended run **completes, fails, needs input, is cancelled, or is interrupted**. It sends through [Resend](https://resend.com). Set a key and a recipient where `autopilot serve` runs:

```sh
export RESEND_API_KEY=re_...
export AUTOPILOT_NOTIFY_EMAIL_TO=you@example.com            # comma-separated for several
export AUTOPILOT_NOTIFY_EMAIL_FROM="Autopilot <bot@your-verified-domain.com>"   # optional
```

Or in the config file:

```json
{ "runNotifications": { "email": { "to": ["you@example.com"], "from": "Autopilot <bot@your-domain.com>", "events": ["needs_input", "failed", "completed"] } } }
```

The email gives the run id, the task (with credential-looking strings redacted), the status and stop reason, the branch, tokens and cost, and the command to inspect or resume it over SSH. It never includes transcript content.

Delivery is separate from run state:
- **Queued with the state change.** A notification is recorded in the same database transaction as the state change, before anything is sent. A provider outage never blocks a run.
- **Rejections:** a rejected send is retried if the provider says it's temporary (429/5xx), and marked failed otherwise.
- **Unknown outcomes:** a network error, a timeout, or a server crash mid-send marks the notification uncertain. It's retried with the **same idempotency key**, so Resend delivers it at most once.
- **Stale notifications** older than 24 hours (Resend's idempotency window) are not sent, so turning email on later doesn't flood you with old runs.

Each run's notifications (status, attempts, provider message id) are in the `run_notifications` table of the runs database.

## Restart and machine-lifetime guarantees

Waiting runs and their timers are stored in SQLite, and the training process is detached from the Autopilot server process. If the server restarts while an agent turn is active, Autopilot resumes automatically only when the latest saved session checkpoint has no tool call with an unknown outcome. If any tool intent occurred after the last saved checkpoint—whether its result is missing or the result was journaled but not yet saved into the session—the run becomes `interrupted_unknown`; Autopilot will not risk replaying an action such as starting a second training job.

This is process-restart recovery, **not** machine-reboot durability. A detached local process cannot survive a host reboot, power loss, container replacement, or lost GPU. For multi-week training, checkpoint to durable storage and run under a host/cluster service manager; use Autopilot to coordinate and inspect that workload. The Autopilot server itself must also be kept running by a service manager for scheduled check-ins to fire.
