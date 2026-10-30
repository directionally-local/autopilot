# Local Hotcell subagents

Autopilot delegates independent investigations to **subagents** through the `subagent` tool. Each subagent is a separate, read-only Autopilot instance running in a **local Hotcell sandbox** (there is no remote worker mode). The main agent owns the conversation, decides whether parallel investigation is useful, and applies any changes itself. The tool used to be called `spawn_worker`; old sessions that reference it keep working.

The `subagent` tool is always offered as a direct tool, including in Code Mode (where it sits next to `execute_code` instead of inside its sandbox API).

## Automatic delegation

**/subagents auto** is the default. For substantial requests, the coordinator may split independent research into bounded missions, launch read-only subagents in parallel, wait for their results, and synthesize them. Small, sequential, or tightly coupled work stays in the main session. An explicit request for or against delegation takes precedence.

**/subagents suggest** requests conservative suggestions; **/subagents off** disables automatic suggestions. Worker calls still require normal tool permission. When the coordinator launches several workers in one step they run in parallel, and a single prompt listing every mission approves (or denies) the whole batch. Running subagents are listed in the activity panel opened with `/agents`, which also has a Stop action per subagent; `/subagents list` shows them and `/subagents cancel <n>` (or `/subagents cancel all`) stops one without interrupting the turn or the other workers. These commands run immediately even while the agent is busy. Interrupting a turn (Ctrl+C) is separate and still stops everything. The old `/multi-agent` and `/remote` commands (Cloudflare workers and remote sessions) were removed.

Automatic subagents are for research only. Workers cannot edit files, open PRs, or execute the old remote execute mode. The coordinator performs implementation in the local checkout after reviewing findings.

## Hotcell requirements

- Install and start the Hotcell CLI/daemon locally.
- Configure the daemon's OpenRouter gateway route with `hotcell keys add openrouter` on the daemon host.
- Use OpenRouter as the active provider (`/provider openrouter`). Hotcell's egress gateway only speaks OpenRouter, so subagents are unavailable while another provider (OpenAI, DeepSeek, Ollama, Requesty, a custom endpoint, …) is active.
- Run inside a Git repository. Private repositories work and nothing needs to be pushed: Autopilot packs your current working tree — tracked files with your edits plus untracked files that aren't gitignored — and streams it into the sandbox. No clone and no GitHub credentials are involved. Secrets are never copied, even if tracked (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, …). The subagent sees files, not Git history.
- If the packed tree exceeds 24 MB compressed, the sandbox instead clones `origin` (which then needs a credential-free HTTPS or SSH URL the daemon can clone, so a public repository) and applies your local changes as a patch. `KIMIFLARE_WORKER_ARCHIVE=0` forces that clone path.
- The subagent runtime (the Autopilot CLI matching your version, `autopilot-ai@<version>`) is built once per version in a scratch sandbox (about two minutes, the first time only), saved as a Hotcell backup, and restored into each subagent's sandbox in about a second. The cache record lives in `~/.config/autopilot/hotcell-worker-cache.json`; set `KIMIFLARE_WORKER_CACHE=0` to install per sandbox instead. Your project's own dependencies and install scripts are never run. `KIMIFLARE_WORKER_PACKAGE` overrides the npm spec (for example a tarball while developing Autopilot), and `KIMIFLARE_WORKER_SETUP_TIMEOUT_MS` changes the setup timeout (default 5 minutes, separate from the research timeout).
- The same active model ID is passed to the worker. Autopilot does not silently switch models.

Hotcell workers have a narrow read-only tool profile, a wall-clock timeout, a concurrency limit, and a cleanup lifecycle. Autopilot does not impose a dollar spend cap or input-token budget; the Hotcell daemon owns provider credentials and injects its gateway token, and Autopilot does not pass its OpenRouter key to the sandbox.

## Limits

Workers add model cost and latency. The default research timeout is ten minutes, and at most three Hotcell cells run concurrently. Configure those limits with KIMIFLARE_WORKER_TIMEOUT_MS and KIMIFLARE_WORKER_MAX_PARALLEL. Actual cost is read from Hotcell stats, included with the result, and remains visible in `/cost`; no fixed dollar or input-token budget cuts research short. Old `workerBudgetUsd`/`workerBudgetMaxUsd` config keys and `KIMIFLARE_WORKER_BUDGET_*` environment variables are ignored (and legacy config keys are removed on migration). Workers end with a JSON report of cited findings, open questions, and files read, which the coordinator receives as structured results; an answer without a valid report is passed through and marked unverified.

Legacy workerEndpoint, workerApiKey, KIMIFLARE_WORKER_ENDPOINT, and KIMIFLARE_WORKER_BACKEND settings do not enable or route workers.

## Usage stats

`/subagents stats` summarizes the last 7 days on this machine: sessions, how many offered the subagent tool and how many used it, completion rate, failure categories (repository, hotcell, provider, budget, timeout, cancelled), median duration, and total cost. Events are appended to `~/.local/share/autopilot/subagents.jsonl` and contain only session ids, the policy decision, outcomes, durations, and costs — never prompts, missions, or code.

## If a worker cannot start

Autopilot reports Hotcell setup, repository, provider, and timeout failures as tool errors. It does not silently fall back to a remote service. The coordinator can continue locally, but should not claim a worker ran when it did not.

For upstream design inspiration, see [Anthropic’s guide to when to use subagents](https://claude.com/blog/subagents-in-claude-code) and the [Claude Code subagents documentation](https://code.claude.com/docs/en/sub-agents).

## Background subagents

`subagent` takes `background: true`: the call returns a worker id at once and the agent keeps working (or answers you) while the subagent runs. When it finishes, its findings are delivered to the agent automatically — at the next tool step if a turn is running, or with your next message — with no polling. The agent can also check early with `worker_status`, fetch one with `worker_result` (optionally `wait=true`), or `wait_for` with `worker_id`.

Background subagents keep every safeguard: the same permission prompt, timeout, concurrency limit and read-only profile. They are not tied to a turn — interrupting a turn doesn't stop them — so stop one with `/subagents cancel <n>`. They live as long as the Autopilot session (the TUI shows "Background subagent #n …" when one finishes; the SDK emits `worker.finished`); disposing an SDK session cancels its running background subagents.
