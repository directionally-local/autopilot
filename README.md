<p align="center">
  <img src="https://raw.githubusercontent.com/sinameraji/autopilot/main/docs/logo.png" alt="Autopilot logo" width="160">
</p>

<h1 align="center">autopilot <sub>(formerly kimiflare)</sub></h1>

<p align="center">
  <a href="https://www.npmjs.com/package/autopilot-ai"><img src="https://img.shields.io/npm/v/autopilot-ai?style=flat-square&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/sinameraji/homebrew-tap"><img src="https://img.shields.io/badge/Homebrew-Install-FBB040?style=flat-square&logo=homebrew&logoColor=black" alt="Install with Homebrew"></a>
  <a href="https://www.npmjs.com/package/autopilot-ai"><img src="https://img.shields.io/npm/dm/autopilot-ai?style=flat-square&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/sinameraji/autopilot/blob/main/LICENSE"><img src="https://img.shields.io/github/license/sinameraji/autopilot?style=flat-square&color=2ea44f" alt="license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/typescript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/runs%20on-OpenRouter%20·%20OpenAI%20·%20DeepSeek%20·%20Ollama%20·%20…-6566f1?style=flat-square" alt="Runs on OpenRouter, OpenAI, DeepSeek, Ollama and more">
</p>

<p align="center">
  <strong>A terminal coding agent that runs on your own provider key.</strong><br>
  OpenRouter (400+ models, per-turn billed cost), OpenAI, DeepSeek, Kimi, Z.ai, local Ollama / LM Studio, or any OpenAI-compatible endpoint.
</p>

<p align="center">
  Part of <a href="https://directionallylocal.com">Directionally Local</a>, an open-source stack for running coding agents on your own hardware, alongside <a href="https://directionallylocal.com/hotcell/">Hotcell</a> and <a href="https://directionallylocal.com/serverless-objects/">Serverless Objects</a>. Product page: <a href="https://directionallylocal.com/autopilot/">directionallylocal.com/autopilot</a>.
</p>

## How it works

autopilot sends every model call to **the provider you choose** using **your own key** — bring-your-own-key, nothing proxied, nothing marked up. On first run you pick a provider, connect it once (the key is checked before it's saved) and pick a model. That's the whole setup. [OpenRouter](https://openrouter.ai) is the recommended default; see [Providers](#providers) for the rest.

On OpenRouter you also get:

- **Any model, one key.** The model picker is OpenRouter's live catalog — Claude, GPT, Gemini, Grok, Qwen, GLM, Kimi, DeepSeek, free models and more — opening on the best & latest by benchmark score, with fuzzy search over everything. Switch any time with `/model`.
- **Real cost, per turn.** OpenRouter reports what each generation actually cost; the status bar shows it (a local estimate marked `≈$` only until the billed number arrives). `/cost` totals it by session, day, month and all time.
- **Reliable tool calling.** Requests only go to upstream providers that support every parameter autopilot sends (tools above all), and OpenRouter routes tool-calling traffic to the providers with the best tool-call success rates. The status bar shows which provider served the last turn.
- **Prompt caching that stays warm.** Each session pins to one upstream provider (OpenRouter sticky routing), so the long, stable prompt prefix keeps hitting the provider's cache across turns.

## What to remember

- **Up to 1M+ context** (model-dependent) — Read entire modules, large configs, and full stack traces without the model losing track.
- **Image understanding** — Drop image paths (PNG, JPG, WebP, GIF, BMP up to 5 MB) into any prompt. Great for UI reviews, diagrams, and screenshots.
- **Plan / Edit / Auto modes** — `plan` is a whitelist-only research mode: only read-only tools (read, glob, grep, web search, GitHub read-only, browser fetch) are allowed. Writes, edits, mutating bash, MCP tools, and LSP renames are all blocked. `edit` (default) prompts per mutating call. `auto` approves everything for trusted tasks.
- **Subagents** — By default, the coordinator assesses substantial tasks for independent research and may delegate without special phrasing. Worker calls still go through permission checks and need a configured backend. See the [subagents guide](docs/subagents.md) for examples, controls, limits, and setup.
- **Long-running unattended runs** — The headless server can launch detached jobs, sleep between check-ins, and resume from saved checkpoints. Overall runtime, token, cost, and action budgets are optional; explicit budget exhaustion pauses for input. See the [long-running runs guide](docs/long-running-unattended-runs.md).
- **Windows support** — OS-aware shell auto-detects `cmd.exe` / PowerShell on Windows, `bash` on Unix. The `bash` tool works out of the box on all platforms.
- **Message queuing** — Submit multiple messages while the agent is busy; they queue and auto-drain. Escape interrupts the current turn but preserves the queue.
- **Smart permission modal** — Denying a tool opens inline feedback so you can tell the agent what to do instead. Keyboard-native navigation (`↑/↓`, `j/k`, `Alt+1/2/3`).
- **Loop guardrails** — Agent hard-stops when all tools in a turn are blocked, preventing infinite token-burning cycles.
- **Persistent all-time cost history** — Append-only `history.jsonl` tracks daily usage forever, so `/cost` shows true all-time and monthly totals that survive across sessions and version updates.
- **LSP + MCP** — Semantic code intelligence (hover, go-to-definition, references, diagnostics) via Language Server Protocol. Extend with external tools via Model Context Protocol.
- **Local structured memory** — SQLite + embeddings cross-session memory. The agent recalls facts, instructions, and preferences across sessions via `remember`, `recall`, and `forget` tools.
- **Web search, GitHub, and headless browser** — Research the web, read GitHub repos, and fetch JavaScript-rendered pages without leaving your terminal.

## Recently shipped

- **OpenRouter as the model provider** — Every OpenRouter model, your own key, billed cost per turn. Replaces Cloudflare Workers AI / AI Gateway (see [Upgrading from Cloudflare](#upgrading-from-the-cloudflare-version)).
- **OS-aware shell with Windows support** — Auto-detects `cmd.exe`, PowerShell, or bash based on platform. Override with `KIMIFLARE_SHELL` or `/shell`.
- **Smart permission modal with inline feedback** — Deny a tool and immediately tell the agent what to do instead. Keyboard-native navigation with `↑/↓`, `j/k`, `Alt+1/2/3`.
- **True message queuing** — Enter queues messages while the agent is busy; Escape interrupts and auto-drains the queue.
- **Hard-stop loop guardrail** — Stops token-burning cycles when all tools in a turn are blocked.
- **Headless SDK** — Programmatic `createAgentSession` API and JSONL-over-stdio RPC mode for building on top of autopilot.

See the full changelog at [github.com/sinameraji/autopilot/releases](https://github.com/sinameraji/autopilot/releases).

## Quick start

```sh
npm install -g autopilot-ai
autopilot
```

On first run, **Sign in with OpenRouter**: approve autopilot in your browser and a key is created for you (or paste one from <https://openrouter.ai/keys>). Then pick a model. That's it.

Or install with Homebrew on macOS or Linux (Homebrew installs Node.js for you):

```sh
brew install sinameraji/tap/autopilot
autopilot
```

Or run without installing:

```sh
npx autopilot-ai
```

> **Coming from `kimiflare`?** The package was renamed. Run `npm uninstall -g kimiflare && npm install -g autopilot-ai` and use `autopilot` instead of `kimiflare`. Your settings, sessions, memory and cost history are kept (they stay in `~/.config/kimiflare` and `~/.local/share/kimiflare`), and `KIMIFLARE_*` environment variables still work.

Requires Node.js ≥ 20.

### Providers

| Provider | id | Key | Notes |
|---|---|---|---|
| [OpenRouter](https://openrouter.ai) (default) | `openrouter` | `OPENROUTER_API_KEY` or browser sign-in | 400+ models, billed cost per turn, sticky routing, subagents, Jev checks |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | native Messages API: extended/adaptive thinking, explicit prompt caching (API keys only — Claude Pro/Max sign-in isn't permitted for third-party tools) |
| OpenAI | `openai` | `OPENAI_API_KEY` | Responses API: reasoning carries across tool loops (encrypted, stateless), codex models |
| Google Gemini | `gemini` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | OpenAI-compatible endpoint; Gemini 3 thought signatures are kept with each tool call |
| ChatGPT (Plus/Pro/Team plan) | `chatgpt` | `autopilot auth chatgpt` (browser sign-in with token sharing) | your plan's GPT models over the Responses API; tokens refresh automatically; usage counts against your plan. Uses OpenAI's official token-sharing sign-in, not the Codex backend |
| GitHub Copilot | `copilot` | `autopilot auth copilot` (GitHub device login; `--enterprise <domain>`) | your Copilot plan's models — Claude over Messages, GPT over Responses; usage counts as premium requests. Not a documented public API, so GitHub may change it |
| Google Vertex AI | `vertex` | Google credentials (`gcloud auth application-default login`, a service-account key in `GOOGLE_APPLICATION_CREDENTIALS`, or `GOOGLE_VERTEX_ACCESS_TOKEN`) + `GOOGLE_VERTEX_PROJECT` (or `autopilot auth vertex --project …`) | Gemini and partner models through Vertex's OpenAI-compatible endpoint, Claude through Anthropic's Messages API on Vertex; location `GOOGLE_VERTEX_LOCATION` (default `global`) |
| Amazon Bedrock | `bedrock` | `AWS_BEARER_TOKEN_BEDROCK` (Bedrock API key), or AWS credentials (env or `~/.aws/credentials` / `AWS_PROFILE`; for SSO, `eval "$(aws configure export-credentials --format env)"`); region `AWS_REGION` | Converse API with SigV4 signing; Claude thinking and prompt caching; inference-profile ids like `global.anthropic.claude-sonnet-5-5` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | |
| MiniMax | `minimax` | `MINIMAX_API_KEY` | OpenAI-compatible endpoint with split reasoning (`<think>` tags are separated out if they appear) |
| Moonshot AI (Kimi) | `moonshot` | `MOONSHOT_API_KEY` | |
| Kimi Code (subscription) | `kimi-code` | `KIMI_API_KEY` | |
| Z.ai (GLM) | `zai` | `ZHIPU_API_KEY` | |
| Z.ai GLM Coding Plan | `zai-coding` | `ZHIPU_API_KEY` | |
| xAI | `xai` | `XAI_API_KEY` | Grok over the Responses API |
| Mistral | `mistral` | `MISTRAL_API_KEY` | tool-call ids adapted to Mistral's format; `mistral-embed` |
| Groq · Cerebras · Together AI · Fireworks AI · DeepInfra | `groq` · `cerebras` · `together` · `fireworks` · `deepinfra` | `GROQ_API_KEY` · `CEREBRAS_API_KEY` · `TOGETHER_API_KEY` · `FIREWORKS_API_KEY` · `DEEPINFRA_API_KEY` | fast / open-model hosts |
| Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` | many vendors with one key |
| Cloudflare Workers AI | `cloudflare` | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (or `autopilot auth cloudflare --account-id …`) | Cloudflare-era kimiflare configs reuse their credentials, and memory stays on `bge-base-en-v1.5`. For **AI Gateway**, use its OpenAI-compatible URL as a `custom` endpoint |
| Azure OpenAI | `azure` | `AZURE_API_KEY` + `AZURE_RESOURCE_NAME` (or `autopilot auth azure --resource <name>`) | v1 API over Responses; model ids are your deployment names, discovered from the resource. Entra ID sign-in isn't supported yet — use a key |
| Ollama (local) | `ollama` | none | installed models are discovered; `providers.ollama.baseUrl` for another host |
| LM Studio (local) | `lmstudio` | none | |
| Requesty | `requesty` | `REQUESTY_API_KEY` | |
| Any OpenAI-compatible endpoint | `custom` | `KIMIFLARE_API_KEY` (optional) | `KIMIFLARE_BASE_URL` — LiteLLM, vLLM, llama.cpp, a company gateway |

- **First run** asks which provider to use; providers with a key already in your environment are offered first and used without saving the key.
- **Switch any time** with `/provider <id> [key]` (`/provider` lists them and where each key comes from), or from the CLI: `autopilot auth <id>` (saves a key and makes it active), `autopilot auth use <id>`, `autopilot auth status`. For one run, set `AUTOPILOT_PROVIDER=<id>`.
- **Everything follows the provider**: chat, compaction and memory side-calls, memory/skill embeddings, the model picker (each provider's own catalog — models.dev for hosted providers, live discovery for Ollama and LM Studio), pricing, error messages and the status page link. Nothing is sent to OpenRouter while another provider is active.
- **OpenRouter-only features** switch off on other providers: billed-cost confirmation (elsewhere `/cost` shows estimates from the provider's published prices), Hotcell subagents, and the Jev completion/triage checks.
- **Embeddings**: providers without an embeddings API (Anthropic, DeepSeek, Moonshot, Kimi Code, the Coding Plan, LM Studio) keep memory working through text and topic-key recall. To keep vector recall, set `"embeddingProvider": "openai"` (or `AUTOPILOT_EMBEDDING_PROVIDER`) with that provider's key, or `memoryEmbeddingModel`.

Config file shape (keys can live here instead of the environment):

```json
{
  "provider": "deepseek",
  "providers": {
    "deepseek": { "apiKey": "sk-…", "model": "deepseek-v4-pro" },
    "ollama": { "baseUrl": "http://gpu-box:11434/v1" }
  }
}
```

### Your OpenRouter key

Three ways to provide it — the first one found wins:

1. **Environment:** `OPENROUTER_API_KEY` (or `KIMIFLARE_OPENROUTER_KEY`). With this set, the setup screen never appears — the way to run kimiflare headless (CI, a VM, a container).
2. **Sign in / setup screen / CLI:** "Sign in with OpenRouter" on first run, or `autopilot auth openrouter` — approve in the browser and a key is created and saved (OpenRouter's OAuth PKCE flow). Over SSH or in a container it shows a link to open on any device and asks for the code OpenRouter displays (force this with `--code`). `--paste` prompts for an existing key instead, and `autopilot auth openrouter <key>` saves one directly. Inside the TUI, `/key set <key>` replaces it.
3. **Config file:** `"openrouterApiKey": "sk-or-…"` in `~/.config/kimiflare/config.json` (created with mode 600).

`/key` shows which key is in use, what it has spent and how much credit is left. Model calls — including memory embeddings and small internal side-calls (summaries, memory extraction) — are all billed to this key.

A key with no credits can still use OpenRouter's **free models** (the "Free" section of `/model`, ids ending in `:free`), subject to OpenRouter's daily request cap.

### Upgrading from the Cloudflare version

Earlier kimiflare versions ran on Cloudflare Workers AI / AI Gateway. On the first launch after upgrading you'll be asked for an OpenRouter key once; after that:

- Your settings (theme, MCP/LSP servers, hooks, memory, sessions, cost history) carry over.
- Model ids are migrated (`@cf/moonshotai/kimi-k2.6` → `moonshotai/kimi-k2.6`, and so on), and the retired Cloudflare fields (OAuth login, gateway, Unified Billing, provider keys) are removed from `config.json`.
- Memory keeps working unchanged: on OpenRouter, embeddings use the same `bge-base-en-v1.5` model Workers AI served.
- `/gateway`, `autopilot auth cloudflare`, `--cloud` and the Cloud-only commands are gone. `/multi-agent` (Commute) is retired; subagents now run locally through Hotcell.

### Subagents

For substantial tasks, the agent can hand independent investigations to **subagents**: separate Autopilot instances that each explore the repository in their own local [Hotcell](https://github.com/sinameraji/hotcell) sandbox and report back cited findings. Several subagents run in parallel behind a single approval while the main agent keeps the conversation and does the edits. You don't need to ask for them; say "don't use subagents" to opt out, or "use subagents" to insist.

Setup: install and start Hotcell, then add your OpenRouter key to its host key store (`hotcell keys add openrouter`). The real key never enters a sandbox. Subagents are read-only (no edits, shell, PRs, or MCP) and see your current working tree, including uncommitted changes — it is streamed into the sandbox, so private repositories work and nothing needs to be pushed (secrets like `.env` are never copied). The first subagent after an install builds a cached runtime (about two minutes, once per version); later ones start in seconds. See [docs/subagents.md](docs/subagents.md) for limits and troubleshooting.

While subagents run they are listed above the prompt (Ink) or in the activity panel (`/agents`, Camouflage). `/subagents cancel <n>` stops one without interrupting the turn, and `/subagents stats` shows how often subagents were offered, used, and succeeded over the last week (kept locally in `~/.local/share/kimiflare/subagents.jsonl`; no prompts or code are recorded).

### Model

You pick the model on first run, and can switch any time with `/model`. The picker opens on the **best & latest** models — recent, tool-capable models ranked by the agentic and coding benchmark scores OpenRouter publishes (Artificial Analysis), at most two per lab — so it stays current as new models ship, with no list maintained in code. Start typing to fuzzy-search all of them (`sonet` finds Claude Sonnet, `gpt 6` the GPT-6 family). Or set one directly:

```sh
/model moonshotai/kimi-k3          # 1M context
/model anthropic/claude-sonnet-5
/model deepseek/deepseek-v4-flash
autopilot -m moonshotai/kimi-k2.7-code -p "..."
```

Any OpenRouter model id works, including variants like `:free` and `:nitro`. Models OpenRouter lists without tool calling are hidden from the picker — a coding agent needs tools.

**Provider routing (optional).** OpenRouter serves most models through several upstream providers. autopilot always requires providers that support every parameter it sends, and otherwise leaves routing to OpenRouter (price-weighted, uptime-aware, tool-calling quality first, sticky per session for caching). To steer it, add an `openrouterProvider` object to the config file — any of OpenRouter's [provider preferences](https://openrouter.ai/docs/guides/routing/provider-selection):

```json
{ "openrouterProvider": { "ignore": ["SomeProvider"], "data_collection": "deny" } }
```

Avoid `order` / `sort` unless you need them: they turn off sticky routing, which is what keeps the prompt cache warm.

### Custom gateway endpoint

Point every model call at your own OpenAI-compatible endpoint instead of OpenRouter — useful when a
host application (CI, an agents platform, a container) fronts model access with its own broker and
doesn't want to hand autopilot a raw provider key:

```sh
export KIMIFLARE_BASE_URL="https://your-broker.example.com/v1"  # /chat/completions is appended
export KIMIFLARE_API_KEY="<bearer for that endpoint>"           # optional; header omitted if unset
autopilot -p "..."        # or --mode rpc — no OpenRouter key needed
```

The same pair can be persisted in `~/.config/kimiflare/config.json` as `baseUrl` / `apiKey`
(env vars win over the file, field by field). When a base URL is configured:

- Chat requests go to `<baseUrl>/chat/completions` and memory embeddings to `<baseUrl>/embeddings`,
  with `Authorization: Bearer $KIMIFLARE_API_KEY` (no `Authorization` header at all when the key is
  unset — e.g. a local llama.cpp/Ollama server).
- Model ids pass through in the request body unchanged; your endpoint owns provider dispatch.
- Cost is the local estimate only — your endpoint does its own metering.

### Requesty (optional)

[Requesty](https://requesty.ai) is another OpenAI-compatible gateway you can use with your own key
instead of OpenRouter. It is opt-in: it is only used when no OpenRouter key and no custom endpoint
are configured, so an existing setup never changes.

```sh
export REQUESTY_API_KEY="<your key>"   # from https://app.requesty.ai/api-keys
autopilot                              # or: autopilot auth requesty (checks and saves the key)
autopilot -p "..." -m openai/gpt-4o-mini
```

- The key can also live in `~/.config/kimiflare/config.json` as `requestyApiKey` (the env var wins).
- `REQUESTY_BASE_URL` picks a region, e.g. `https://router.eu.requesty.ai/v1` for the EU. Only https URLs on Requesty's hosts (`router.requesty.ai`, `router.eu.requesty.ai`, `router.us.requesty.ai`, `router.ap.requesty.ai`) are accepted, so the key is never sent anywhere else.
- `/model` lists Requesty's managed policies first (short ids such as `kimi-k2.6` or
  `claude-sonnet-4-5`), then its full `vendor/model` catalog. Both kinds of id work.
- Defaults on Requesty: `kimi-k2.6` for the main model, `deepseek-v4-flash` for side calls, and
  `openai/text-embedding-3-small` for memory embeddings.
- Cost per turn is the one Requesty reports inline. `/key` shows whether the key is valid; OpenRouter
  only features (browser sign in, `/key set`, the billed cost lookup) are not available.

### One-shot mode

```sh
autopilot -p "summarize PLAN.md"                    # stream answer to stdout
autopilot -p "..." --dangerously-allow-all          # auto-approve mutating tools (for scripts)
autopilot -p "..." --reasoning                      # include chain-of-thought in stderr
```

### Headless SDK

Use autopilot programmatically from your own application — no TUI required.

```ts
import { createAgentSession } from "autopilot-ai/sdk";

const { session } = await createAgentSession({
  cwd: "/path/to/project",
  config: {
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    model: "moonshotai/kimi-k2.7-code",
  },
});

// Stream every event: text deltas, tool calls, tasks, usage
session.subscribe((event) => {
  console.log(event.type, event);
});

// Send a prompt
await session.prompt("Refactor auth to JWT + Redis");

// Mid-flight correction while the agent is still running
await session.steer("Use Redis instead of in-memory store");

// After the turn finishes
await session.followUp("Also add unit tests");

// Clean up
session.dispose();
```

**Key features:**
- `subscribe()` — receive typed events (`text_delta`, `tool_call`, `tool_result`, `task_update`, `usage`, `warning`, `error`, `done`, etc.)
- `prompt()` / `steer()` / `followUp()` — full conversation lifecycle
- `pause()` / `resume()` — graceful preemption
- `getStatus()` / `getUsage()` — inspect session state
- Custom `permissionHandler` — decide programmatically whether to allow mutating tools
- Optional `memoryEnabled`, `lspEnabled`, `costAttribution` flags

#### SDK Authentication

The SDK uses the active [provider](#providers) — `provider` in `config` (or `AUTOPILOT_PROVIDER`),
else OpenRouter — and needs its key: `providers.<id>.apiKey` in `config` or the provider's env var
(`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, …). A [custom gateway endpoint](#custom-gateway-endpoint)
(`baseUrl` / `apiKey` in `config`, or `KIMIFLARE_BASE_URL` / `KIMIFLARE_API_KEY`) needs no other key.
For OpenRouter, the key is resolved in this priority order:

1. **Explicit `config` object** (`openrouterApiKey`) — recommended for apps
2. **Environment variables**: `OPENROUTER_API_KEY` / `KIMIFLARE_OPENROUTER_KEY`
3. **Config file**: `~/.config/kimiflare/config.json`

A [Requesty](#requesty-optional) key (`requestyApiKey` in `config`, or `REQUESTY_API_KEY`) also works
when no OpenRouter key is set; pass a Requesty model id such as `openai/gpt-4o-mini` as `model`.

Pass `provider` in `createAgentSession` options to set OpenRouter provider-routing preferences for that session.

**For Electron / desktop apps**, we recommend storing the key in the OS keychain (e.g. Electron `safeStorage` or `keytar`) and passing it explicitly:

```ts
import { createAgentSession } from "autopilot-ai/sdk";

const openrouterApiKey = await keytar.getPassword("autopilot", "openrouter");

const { session } = await createAgentSession({
  cwd: projectPath,
  config: { openrouterApiKey },
});
```

#### RPC mode (subprocess)

If you need process isolation or a non-Node consumer, run autopilot in JSONL-over-stdio RPC mode:

```sh
node bin/autopilot.mjs --mode rpc
```

Give the subprocess `OPENROUTER_API_KEY` — or a [custom gateway endpoint](#custom-gateway-endpoint)
(`KIMIFLARE_BASE_URL` + `KIMIFLARE_API_KEY`), ideal for host apps that broker model access themselves.

```ts
import { spawn } from "node:child_process";

const proc = spawn("npx", ["autopilot-ai", "--mode", "rpc"], {
  cwd: projectPath,
  stdio: ["pipe", "pipe", "pipe"],
});

// Read events
proc.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    console.log(event.type, event);
  }
});

// Send commands
proc.stdin.write(JSON.stringify({ type: "new_session" }) + "\n");
proc.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Resolve a permission request
proc.stdin.write(
  JSON.stringify({ type: "resolve_permission", requestId: "req_0", decision: "allow" }) + "\n"
);

// Resume a previous session after a process restart (the `new_session`
// response echoes back the sessionId to store for later)
proc.stdin.write(JSON.stringify({ type: "new_session", sessionId: "sdk-session-…" }) + "\n");
```

### Image understanding

```sh
autopilot
› fix the layout bug in this screenshot docs/bug.png
› convert this mockup design.png to Tailwind HTML
```

## Slash commands

| Command | Effect |
|---------|--------|
| `/mode edit\|plan\|auto` | Switch permission mode |
| `/shell auto\|bash\|cmd\|powershell` | Show or set the shell for the bash tool |
| `/thinking low\|medium\|high` | Reasoning effort (persists) |
| `/theme` | Interactive theme picker (`Ctrl+T`) |
| `/resume` | Pick a past conversation to restore |
| `/compact` | Summarize older turns to free context |
| `/init` | Scan repo and write `KIMI.md` project context |
| `/memory` | Show memory stats and search |
| `/mcp list` / `/mcp reload` | Manage MCP servers |
| `/reasoning` | Toggle chain-of-thought display |
| `/model` | Pick a model from the active provider's catalog (or `/model <id>`, `/model list [filter]`) |
| `/provider` | List providers, or switch with `/provider <id> [key]` (see [Providers](#providers)) |
| `/jev` | Ask Jev for a typed, scoped one-shot decision |
| `/subagents` | List running subagents; `/subagents cancel <n>\|all` stops them; `/subagents off\|suggest\|auto` sets the delegation policy (default: `auto`) |
| `/now` | Run your latest queued message now instead of after the current turn (also `Ctrl+G` in Ink) |
| `/key` | Show the active provider's key — on OpenRouter with spend and credit (`/key set <key>`, `/key clear`) |
| `/cost` | Show cost by session, day, month and all time (OpenRouter-confirmed, or estimated from the provider's prices) |
| `/update` | Check for updates |
| `/help` | List all commands |

### Subagent routing

`/subagents auto` is the default: on substantial tasks the agent is asked to look for independent parts and delegate them, and it decides whether delegation is worth it. `suggest` only hints at delegation for likely parallel work, and `off` disables harness guidance (you can still ask for subagents explicitly). Explicit requests to use subagents or to work without them always win. Set the policy with `/subagents`, `KIMIFLARE_SUBAGENT_POLICY`, or `subagentPolicy` in config.

The harness never starts a subagent by itself: the agent calls the `subagent` tool, which always needs normal tool permission (one prompt covers a parallel batch) and obeys provider, read-only, spend, concurrency, and timeout limits. In Code Mode the `subagent` tool stays a direct tool next to `execute_code`. Jev (a fast yes/no decision model on OpenRouter) sharpens this: in `auto` mode it checks whether a substantial request has independent parts (strong delegation guidance at ≥80%, otherwise the softer nudge), and in `suggest` mode it decides whether to suggest at all. It receives at most 1,200 characters of redacted request text, runs alongside other pre-turn work, and any failure falls back to the default guidance.

### Finishing the job

When a substantial turn ends without the agent asking you anything, a Jev yes/no check asks whether it actually finished — or clearly explained a blocker — rather than stopping after a plan or "next I'll…". If it clearly didn't, the agent is told to continue (once per turn), so you don't have to type "go on". Typically under a second; OpenRouter only. Turn it off with `"completionCheck": false` in config or `KIMIFLARE_COMPLETION_CHECK=0`.

## Running shell commands yourself

Type `!` followed by a command (for example `! gh auth login`) to run it in your own terminal, inside the session. Logins, password prompts and interactive programs work because the command gets the real TTY. The output is added to the conversation so the agent can see it. The agent's own `bash` tool has no terminal, so autopilot suggests `! <command>` when something needs you: a login, a `sudo` password, an SSH passphrase, or a secret you'd rather not paste into chat. On macOS and Linux the output is captured with `script(1)`; elsewhere the command still runs but its output isn't captured.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+C` / `Esc` | Interrupt current turn when busy; exit when idle |
| `Ctrl+R` | Toggle reasoning display |
| `Ctrl+O` | Toggle verbose tool output |
| `Ctrl+T` | Open theme picker |
| `Shift+Tab` | Cycle mode (edit → plan → auto) |
| `↑` / `↓` | Walk prompt history |
| `Ctrl+G` | While the agent works: run your latest queued message now instead of after the turn |

### Messages sent while the agent is working

A message you send mid-turn is triaged instead of always waiting in line:

- **interrupt** ("stop, that's the wrong file"): the turn stops at the next safe point and your message runs next. Running subagents are never cancelled by an interrupt; while they run, the message is delivered as soon as they finish.
- **steer** ("also handle the empty case"): folded into the current task at the agent's next step.
- **queue** ("after this, update the changelog", or anything unclear): runs as its own turn afterwards. The queue shows `Ctrl+G run this now` so you can promote it.
- **aside** ("how's it going?"): answered from the current state without disturbing the turn.

Clear phrasing is decided instantly; ambiguous messages get a quick model check (OpenRouter only), and anything uncertain is queued. Use `/subagents cancel <n>` to stop a single subagent.

## Logs

autopilot writes structured JSON logs of agent-side activity (tool calls,
permission decisions, MCP/LSP lifecycle, session events, errors) to
`~/.config/kimiflare/logs/<date>.jsonl`, one file per day, with 7-day
retention pruned automatically at startup.

The logs deliberately exclude prompts and completions. To capture full
request/response payloads locally for debugging, run with
`KIMIFLARE_DUMP_LLM=1`; each generation is also visible in your
[OpenRouter activity log](https://openrouter.ai/activity).

```sh
autopilot logs path             # today's file
autopilot logs dir              # log directory
autopilot logs prune            # delete files older than 7 days

# Tail this session's activity, formatted:
tail -f $(autopilot logs path) | jq

# Find the slowest tool calls in the last day:
jq -r 'select(.event == "tool:end") | "\(.data.duration_ms)\t\(.data.tool)"' \
  $(autopilot logs path) | sort -rn | head
```

Disable the file sink entirely with `KIMIFLARE_LOG_SINK=off`. The
separate `KIMIFLARE_LOG_LEVEL` env var (default `off`) controls stderr
output — independent of the file sink.

### Shipping to an OpenTelemetry collector

If you set `KIMIFLARE_OTEL_ENDPOINT`, autopilot also ships each log
entry to that endpoint over [OTLP/HTTP](https://opentelemetry.io/docs/specs/otlp/)
so it lands in Datadog, Honeycomb, Grafana Loki, an internal collector,
or any other backend that speaks OTel. Batched every 5 s (or every
100 entries, whichever first) and best-effort — never blocks the agent
loop.

```sh
# Full path:
export KIMIFLARE_OTEL_ENDPOINT="https://otel.example.com/v1/logs"
# Or just the base URL (we auto-append /v1/logs):
export KIMIFLARE_OTEL_ENDPOINT="https://otel.example.com"

# Optional headers (comma-separated key=value pairs) — e.g. for auth:
export KIMIFLARE_OTEL_HEADERS="Authorization=Bearer xyz,X-Tenant=acme"
```

Each log entry maps to one OTel `LogRecord`. Correlation IDs
(`session_id`, `turn_id`, `request_id`) become record attributes,
`data.*` fields are flattened to attributes with type-preserving
encoding, and a `service.name=kimiflare` + `service.version` pair sits
on the resource.

## Hooks

autopilot can fire shell commands at these points, configured
per-project (`.kimiflare/settings.json`) or globally
(`~/.config/kimiflare/settings.json`):

| Event              | Fires when                                      | Veto? |
|--------------------|-------------------------------------------------|-------|
| `SessionStart`     | A session's first turn (`source`: startup/resume) | No  |
| `PreToolUse`       | A tool call is about to run                     | Yes   |
| `PostToolUse`      | A tool call just finished                       | No    |
| `UserPromptSubmit` | You hit Enter on a prompt                       | Yes   |
| `Stop`             | A turn ended cleanly                            | No    |
| `PreCompact`       | Auto-compaction is about to run                 | No    |
| `SessionEnd`       | autopilot exits, or `/clear` (`reason`)         | No    |

Hooks receive the event payload as JSON on stdin **and** as
`KIMIFLARE_HOOK_*` env vars (for shell-one-liner ergonomics). The full
JSON copy in `KIMIFLARE_HOOK_PAYLOAD` is only set for payloads up to
32 KiB (OSes cap environment variable size); above that it is omitted,
`KIMIFLARE_HOOK_PAYLOAD_OMITTED=1` is set, and stdin is the only source —
prefer reading stdin. Payloads
also carry Claude Code's field names (`hook_event_name`, `tool_name`,
`tool_input`, `tool_response`, `tool_call_id`, `transcript_path`), so
Claude Code hook scripts — and tools built for them, like
[Agent Beacon](docs/beacon.md) — work unchanged.
#### Blocking and exit codes

Veto events (`PreToolUse`, `UserPromptSubmit`) follow Claude Code's rules:

| Hook result | Effect |
|-------------|--------|
| exit `0` | Allowed. Stdout may carry a JSON decision (below). |
| exit `2` | **Blocked.** Stderr (or stdout if stderr is empty) is the reason shown to the model. |
| any other non-zero exit, timeout, command not found (127), spawn error | Logged as a warning; the action is **allowed** (fail-open), so a broken or missing hook never wedges every tool call. |

A `PreToolUse` hook that exits `0` can instead print a JSON decision:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
  "permissionDecision": "deny", "permissionDecisionReason": "no writes to prod config" } }
```

- `deny` blocks, with `permissionDecisionReason` as the reason.
- `ask` sends the call through the normal permission prompt, even for
  tools that don't usually ask. Hosts with no one to ask answer as they
  already do (`--print` denies unless `--dangerously-allow-all`).
- `allow` means the hook doesn't object; it does **not** bypass your own
  permission rules or mode.

With several hooks, `deny` wins over `ask`, which wins over `allow`.
The legacy `{"decision": "block", "reason": "..."}` form also blocks
(use it for `UserPromptSubmit`). Stdout that isn't JSON is ignored, as
before. Hooks written for older versions that blocked with `exit 1`
must switch to `exit 2`.

### Browse + enable from the TUI

```text
/hooks                            # list configured hooks
/hooks recommended                # list starter hooks shipped with autopilot
/hooks enable stop-bell           # enable one (writes to .kimiflare/settings.json)
/hooks enable stop-bell global    # ...or the global file
/hooks disable stop-bell
/hooks path                       # print settings.json paths
/hooks reload                     # re-read settings.json after a manual edit
```

The recommended catalog includes terminal bells / macOS notifications
on `Stop`, secret-file guards on `PreToolUse` (e.g. block edits to
`*.env`), auto-format-with-prettier on `PostToolUse`, and a tool-call
audit log. All ship disabled — `/hooks recommended` lists them.

### Schema example

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "id": "no-secrets",
        "matcher": "^(edit|write)$",
        "command": "case \"$KIMIFLARE_HOOK_PATH\" in *.env|*.pem) echo 'blocked' >&2; exit 2;; esac"
      }
    ],
    "PostToolUse": [
      {
        "id": "format-ts",
        "matcher": "^(edit|write)$",
        "command": "npx --no-install prettier --write \"$KIMIFLARE_HOOK_PATH\" >/dev/null 2>&1 || true"
      }
    ],
    "Stop": [
      { "id": "bell", "command": "printf '\\a'" }
    ]
  }
}
```

Per-hook fields:
- `command` (required) — the shell command.
- `matcher` (optional) — anchored regex matched against the tool name
  for `PreToolUse` / `PostToolUse`. Ignored for other events.
- `id` (optional) — stable handle for `/hooks enable|disable`.
  Auto-derived from `event + command` when omitted.
- `enabled` (default `true`) — set `false` to keep a hook in config
  but skip it.
- `timeoutMs` (default `30000`) — hard kill if the hook hangs (the
  action then proceeds, with a warning).
- `description` (optional) — shown by `/hooks list`.

Hooks are always-on infrastructure: they fire whether the TUI is open
or autopilot is running in `--print` mode. They also fire for tool
calls generated from inside the Code Mode sandbox (heavy-tier turns),
because hook firing lives on the `ToolExecutor` itself — every call
path uses the same plumbing.

When intent classification has assigned a tier, hook payloads include
it as `tier: "light" | "medium" | "heavy"` (on `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`) and as `$KIMIFLARE_HOOK_TIER`. Useful for
"skip auto-format on light turns" or "audit every heavy-turn write."

SDK consumers opt in to hooks with `enableHooks: true` on
`createAgentSession`. Default is off because the SDK is a primitive,
not the TUI.

## Development

```sh
git clone https://github.com/sinameraji/autopilot
cd autopilot
npm install
npm run build
npm link
```

Scripts:
- `npm run build` — bundle with tsup
- `npm run dev` — run via tsx
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run tests

## Contributing

1. Fork the repository
2. Create a branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Run `npm run typecheck` and `npm run build`
5. Commit with [Conventional Commits](https://www.conventionalcommits.org/)
6. Open a Pull Request

---

Built by [Sina Meraji](https://github.com/sinameraji) and [contributors](https://github.com/sinameraji/autopilot/graphs/contributors) · MIT License
