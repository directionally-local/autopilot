/**
 * OpenAPI 3.1 specification for the KimiFlare headless server.
 */

export function getOpenApiSpec(): string {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "KimiFlare Headless Server API",
      version: "1.0.0",
      description: "HTTP API for running KimiFlare agent sessions headlessly.",
    },
    servers: [{ url: "/", description: "Local server" }],
    paths: {
      "/": {
        get: {
          summary: "Health check",
          responses: {
            "200": {
              description: "Server is running",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { status: { type: "string" }, version: { type: "string" } } },
                },
              },
            },
          },
        },
      },
      "/runs": {
        get: {
          summary: "List durable unattended runs",
          security: [{ basicAuth: [] }],
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500 } }],
          responses: { "200": { description: "Run records" }, "503": { description: "Server password is not configured" } },
        },
        post: {
          summary: "Create a durable unattended run",
          security: [{ basicAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["task"],
              properties: {
                task: { type: "string", maxLength: 20000 },
                cwd: { type: "string", description: "Existing path inside a Git repository; required when worktree is true. With worktree false, defaults to the server working directory." },
                worktree: { type: "boolean", default: true, description: "Create a per-run Git branch/worktree; set false for non-Git jobs." },
                model: { type: "string" },
                allowedTools: { type: "array", items: { type: "string" }, description: "Explicit tool permission allowlist; wait_for is always available." },
                maxToolIterations: { type: "integer", minimum: 1, nullable: true, description: "Optional lifetime tool-action budget; null (default) is unlimited." },
                maxRuntimeMs: { type: "integer", minimum: 1000, nullable: true, description: "Optional total runtime budget; null (default) is unlimited." },
                maxTotalTokens: { type: "integer", minimum: 1, nullable: true, description: "Optional cumulative token budget; null (default) is unlimited." },
                maxCostUsd: { type: "number", minimum: 0.01, nullable: true, default: null, description: "Optional cumulative USD budget; null (default) is unlimited." },
              },
            } } },
          },
          responses: { "202": { description: "Run started" }, "400": { description: "Invalid run options" }, "503": { description: "Server password is not configured" } },
        },
      },
      "/runs/{runId}": {
        get: {
          summary: "Get a durable run status",
          security: [{ basicAuth: [] }],
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Run record" }, "404": { description: "Run not found" } },
        },
      },
      "/runs/{runId}/events": {
        get: {
          summary: "Get a durable run event journal",
          security: [{ basicAuth: [] }],
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Run events; tool arguments and output content are not included" } },
        },
      },
      "/runs/{runId}/resume": {
        post: {
          summary: "Resume a budget-paused run with revised limits",
          security: [{ basicAuth: [] }],
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              minProperties: 1,
              properties: {
                maxToolIterations: { type: "integer", minimum: 1, nullable: true, description: "Set a new lifetime tool-action budget, or null to remove it." },
                maxRuntimeMs: { type: "integer", minimum: 1000, nullable: true, description: "Set a new total runtime budget, or null to remove it." },
                maxTotalTokens: { type: "integer", minimum: 1, nullable: true, description: "Set a new cumulative token budget, or null to remove it." },
                maxCostUsd: { type: "number", minimum: 0.01, nullable: true, description: "Set a new cumulative USD budget, or null to remove it." },
              },
              additionalProperties: false,
            } } },
          },
          responses: { "202": { description: "Run resumed" }, "400": { description: "Invalid budgets" }, "409": { description: "Run is not paused for input" } },
        },
      },
      "/runs/{runId}/cancel": {
        post: {
          summary: "Cancel a queued, running, or waiting run",
          security: [{ basicAuth: [] }],
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Current run state" }, "404": { description: "Run not found" } },
        },
      },
      "/prompt": {
        post: {
          summary: "Start a new agent session with a prompt",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["prompt"],
                  properties: {
                    prompt: { type: "string", description: "The user prompt" },
                    model: { type: "string", description: "Model ID to use" },
                    cwd: { type: "string", description: "Working directory" },
                    title: { type: "string", description: "Session title" },
                    files: { type: "array", items: { type: "string" }, description: "File paths or globs to attach" },
                    allowAll: { type: "boolean", description: "Auto-approve all tool calls" },
                  },
                },
              },
            },
          },
          responses: {
            "202": {
              description: "Session started",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      sessionId: { type: "string" },
                      status: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/session": {
        get: {
          summary: "List sessions",
          parameters: [
            {
              name: "cwd",
              in: "query",
              schema: { type: "string" },
              description: "Filter by working directory",
            },
          ],
          responses: {
            "200": {
              description: "List of sessions",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      sessions: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            cwd: { type: "string" },
                            firstPrompt: { type: "string" },
                            title: { type: "string" },
                            messageCount: { type: "number" },
                            updatedAt: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/session/{id}": {
        get: {
          summary: "Get session state",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Session state",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      cwd: { type: "string" },
                      model: { type: "string" },
                      messages: { type: "array" },
                      title: { type: "string" },
                      updatedAt: { type: "string" },
                    },
                  },
                },
              },
            },
            "404": { description: "Session not found" },
          },
        },
        delete: {
          summary: "Delete a session",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Session deleted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { deleted: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      "/session/{id}/prompt": {
        post: {
          summary: "Send a follow-up prompt to a session",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["prompt"],
                  properties: {
                    prompt: { type: "string" },
                    files: { type: "array", items: { type: "string" } },
                    allowAll: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "202": {
              description: "Follow-up started",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      sessionId: { type: "string" },
                      status: { type: "string" },
                    },
                  },
                },
              },
            },
            "404": { description: "Session not found" },
          },
        },
      },
      "/event": {
        get: {
          summary: "Server-Sent Events stream",
          responses: {
            "200": {
              description: "SSE stream of session events",
              content: {
                "text/event-stream": {
                  schema: {
                    type: "object",
                    description: "Stream of events: server.connected, assistant.delta, tool.call, tool.result, usage.update, session.completed, error",
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/health": {
        get: {
          summary: "Authenticated Aster capabilities and health",
          security: [{ asterBearer: [] }],
          responses: { "200": { description: "API version and supported capabilities; contains no host paths or secrets" }, "401": { description: "Invalid or expired credential" } },
        },
      },
      "/api/v1/auth/device": {
        post: {
          summary: "Start pairing a client with a device code (no credential required)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { clientName: { type: "string", maxLength: 60 } }, additionalProperties: false } } } },
          responses: { "200": { description: "deviceCode (keep secret), userCode to show, verificationUri/verificationUriComplete, expiresIn and interval in seconds" }, "400": { description: "Invalid client name" }, "429": { description: "Too many pairings waiting for approval" } },
        },
      },
      "/api/v1/auth/device/token": {
        post: {
          summary: "Poll a pairing; returns the client credential once after the owner approves",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["deviceCode"], properties: { deviceCode: { type: "string" } } } } } },
          responses: { "200": { description: "{token, credentialId, name, workspaceIds, scopes, expiresAt}; the token is shown once" }, "400": { description: "authorization_pending, slow_down, access_denied, or expired_token" } },
        },
      },
      "/api/v1/auth/approve": {
        get: { summary: "Owner page (HTML) to approve or deny a pairing code; requires the owner cookie", parameters: [{ name: "code", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Approval form" }, "401": { description: "Browser is not the owner" } } },
        post: { summary: "Same-origin form post: code and decision=approve|deny", responses: { "200": { description: "Decision recorded" }, "403": { description: "Cross-origin request" }, "404": { description: "Unknown code" }, "409": { description: "Already decided" }, "410": { description: "Code expired" } } },
      },
      "/api/v1/auth/claim": {
        get: { summary: "Owner claim page (HTML) for a one-time link from `autopilot aster owner link`", parameters: [{ name: "token", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Claim form" } } },
        post: { summary: "Same-origin form post that redeems the claim and sets the owner cookie", responses: { "303": { description: "Claimed; redirects to the approval page" }, "403": { description: "Cross-origin request" }, "410": { description: "Link expired or already used" } } },
      },
      "/api/v1/github/repositories": {
        get: {
          summary: "List repositories accessible to the server's GitHub token",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "q", in: "query", required: false, schema: { type: "string", maxLength: 200 } }],
          responses: { "200": { description: "Repository owner/name, privacy, and default branch metadata" }, "503": { description: "GitHub token is not configured" } },
        },
      },
      "/api/v1/workspaces": {
        get: {
          summary: "List credential-scoped workspaces",
          security: [{ asterBearer: [] }],
          responses: { "200": { description: "Configured workspace IDs and display names only" } },
        },
      },
      "/api/v1/models": {
        get: {
          summary: "List the models conversations may use, and the provider serving them",
          security: [{ asterBearer: [] }],
          responses: {
            "200": {
              description: "The selectable model IDs (a fixed list, or the provider's live catalog), their metadata, the configured provider and its default model",
              content: { "application/json": { schema: {
                type: "object",
                required: ["models", "catalog", "provider", "defaultModel"],
                properties: {
                  models: { type: "array", items: { type: "string" } },
                  catalog: { type: "array", items: { type: "object", required: ["id"], properties: {
                    id: { type: "string" }, name: { type: "string" }, contextWindow: { type: "integer" }, inputPerMtok: { type: "number" }, outputPerMtok: { type: "number" },
                    created: { type: "integer" }, reasoning: { type: "boolean" }, vision: { type: "boolean" },
                  } } },
                  provider: { type: "object", required: ["id", "name"], properties: { id: { type: "string", description: "Autopilot provider preset id (openrouter, deepseek, ollama, …)" }, name: { type: "string" } } },
                  defaultModel: { type: "string", description: "The provider's default model when it is selectable, else the first selectable model" },
                },
              }, example: { models: ["deepseek-v4-pro", "deepseek-flash"], catalog: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }], provider: { id: "deepseek", name: "DeepSeek" }, defaultModel: "deepseek-v4-pro" } } },
            },
            "503": { description: "The model catalog is unavailable right now" },
          },
        },
      },
      "/api/v1/conversations": {
        get: {
          summary: "List the calling credential's conversations, newest first",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }],
          responses: { "200": { description: "{conversations: [...]} in the conversation metadata shape" }, "400": { description: "Invalid limit" } },
        },
        post: {
          summary: "Create a persistent conversation in its own isolated Hotcell microVM",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }, description: "Stable per-credential key; safe retries return the original conversation and never duplicate its cell." }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["workspaceId", "model"],
              properties: {
                workspaceId: { type: "string" },
                model: { type: "string" },
                kind: { type: "string", enum: ["chat", "code"], default: "chat" },
                repository: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$", description: "Required for kind=code; must be accessible to the server's GitHub token." },
                baseCommit: { type: "string", pattern: "^[0-9a-f]{40}$", description: "kind=code only: start from this commit instead of the default branch tip." },
                patch: { type: "string", maxLength: 3145728, description: "kind=code only, requires baseCommit: a binary git diff against it, committed first on the conversation branch." },
              },
              additionalProperties: false,
            }, example: { workspaceId: "default", model: "moonshotai/kimi-k2.6", kind: "code", repository: "acme/project" } } },
          },
          responses: { "201": { description: "Created conversation with opaque ID" }, "200": { description: "Idempotent replay of the original creation" }, "400": { description: "Invalid workspace, model, or missing Idempotency-Key" }, "409": { description: "Idempotency-Key reused with different parameters" }, "410": { description: "Key belongs to a destroyed conversation" }, "503": { description: "Hotcell runtime unavailable or provisioning failed" } },
        },
      },
      "/api/v1/conversations/{conversationId}": {
        get: {
          summary: "Get conversation status without returning model/tool history or filesystem paths",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Conversation metadata and last event cursor" }, "404": { description: "Conversation not found or outside credential scope" } },
        },
        delete: {
          summary: "Revoke the cell's egress tokens and destroy the conversation's Hotcell and volume (retryable)",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Destroyed (idempotent)" }, "404": { description: "Conversation not found" }, "503": { description: "cleanup_pending; retry to finish revocation and teardown" } },
        },
      },
      "/api/v1/conversations/{conversationId}/pause": {
        post: {
          summary: "Suspend the conversation's cell at a safe boundary (no active turn)",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Paused (idempotent); session state persists in the cell" }, "409": { description: "turn_active or cell not ready" } },
        },
      },
      "/api/v1/conversations/{conversationId}/resume": {
        post: {
          summary: "Resume a paused cell and restore the same Autopilot session",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Ready again (idempotent)" }, "409": { description: "Cell not ready" } },
        },
      },
      "/api/v1/conversations/{conversationId}/turns": {
        post: {
          summary: "Append a user turn to the persistent conversation",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { clientTurnId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", description: "Optional stable idempotency key, scoped to this conversation. Omit only for non-idempotent legacy submission." }, text: { type: "string", maxLength: 20000 } }, additionalProperties: false }, examples: { legacy: { summary: "Legacy text-only submission (do not automatically retry ambiguous requests)", value: { text: "Summarize the failing test and propose a fix." } }, idempotent: { summary: "Retry-safe submission", value: { clientTurnId: "turn-550e8400-e29b-41d4-a716-446655440000", text: "Summarize the failing test and propose a fix." } } } } } },
          responses: { "202": { description: "Turn accepted; keyed submissions replay the persisted response for the same ID and text" }, "400": { description: "clientTurnId, when present, or text is invalid" }, "409": { description: "conversation_busy or idempotency_conflict for a reused key with different text" } },
        },
      },
      "/api/v1/conversations/{conversationId}/pull-request/checks": {
        get: {
          summary: "List check runs for the conversation's pull-request branch",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "GitHub check-run status and conclusion values" }, "404": { description: "Conversation or pull request not found" } },
        },
      },
      "/api/v1/conversations/{conversationId}/pull-request/merge": {
        post: {
          summary: "Merge the conversation's pull request after explicit user confirmation",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Merged conversation metadata" }, "409": { description: "No completed pull request is ready to merge" }, "403": { description: "GitHub token cannot merge this pull request" } },
        },
      },
      "/api/v1/conversations/{conversationId}/events": {
        get: {
          summary: "Reconnectable per-conversation SSE stream",
          security: [{ asterBearer: [] }],
          parameters: [
            { name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "Last-Event-ID", in: "header", schema: { type: "integer" }, description: "Replay events with larger sequence IDs." },
            { name: "after", in: "query", schema: { type: "integer", minimum: 0 }, description: "Alternative replay cursor." },
          ],
          responses: { "200": { description: "Typed SSE events with monotonic IDs: status, assistant.delta, tool.activity, approval.required, approval.resolved, approval.expired, usage (cumulative per-run inputTokens, outputTokens, costUsd), todo.updated (full items list), completed, cancelled, failed." } },
        },
      },
      "/api/v1/conversations/{conversationId}/cancel": {
        post: {
          summary: "Idempotently cancel the active run and abort its agent signal",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Current conversation state" }, "404": { description: "Conversation not found" } },
        },
      },
      "/api/v1/approvals/{approvalId}": {
        get: {
          summary: "Review a pending approval action and exact arguments",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "approvalId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Pending action and exact arguments; secret-like actions are rejected before approval" }, "404": { description: "Approval not found" } },
        },
        post: {
          summary: "Allow or deny one pending action; resolution is single-use and idempotent",
          security: [{ asterBearer: [] }],
          parameters: [{ name: "approvalId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["decision"], properties: { decision: { type: "string", enum: ["allow", "deny"] } }, additionalProperties: false }, example: { decision: "allow" } } } },
          responses: { "200": { description: "Resolved approval" }, "409": { description: "Conflicting prior resolution" }, "410": { description: "Approval expired; action was not executed" } },
        },
      },
    },
    components: {
      securitySchemes: {
        basicAuth: { type: "http", scheme: "basic" },
        asterBearer: { type: "http", scheme: "bearer", bearerFormat: "revocable, workspace-scoped Autopilot credential" },
      },
    },
  };

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>KimiFlare Headless Server API</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; }
    pre { background: #f5f5f5; padding: 16px; border-radius: 8px; overflow-x: auto; }
    h1 { border-bottom: 2px solid #333; padding-bottom: 8px; }
    h2 { margin-top: 32px; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>KimiFlare Headless Server API</h1>
  <p>OpenAPI 3.1 specification for the local HTTP server.</p>
  <h2>Spec</h2>
  <pre>${JSON.stringify(spec, null, 2)}</pre>
</body>
</html>`;
}
