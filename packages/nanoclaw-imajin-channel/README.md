# @imajin/nanoclaw-imajin-channel

The Imajin chat bridge for the first hand-built NanoClaw instance
([imajin-ai#1932](https://github.com/ima-jin/imajin-ai/issues/1932)): makes a NanoClaw
instance reachable by DM at its own agent DID through the *existing* `jin.imajin.ai`
chat surface — no new UI — plus the two small sidecars its container depends on.

## Why this name, and why three pieces in one package

The issue's deliverable 2 asks for one thing — "the instance is reachable in
jin.imajin.ai" — but NanoClaw's own extension seams split that into three pieces that
have to ship together and stay in lockstep:

1. **`src/channel-adapter.ts`** — a NanoClaw `ChannelAdapter` (see
   `src/nanoclaw-types.ts` for why the contract is declared locally rather than
   imported). This is the actual "channel" — the piece a NanoClaw checkout runs.
2. **`src/mcp-proxy/`** — a loopback sidecar. NanoClaw's `container.json` MCP entry
   only supports **static** headers, but `mcp.imajin.ai` requires a short-lived
   (10-minute), caller-refreshed app-token JWT
   ([imajin-ai#1922](https://github.com/ima-jin/imajin-ai/issues/1922) finding 6, the
   same constraint `packages/openclaw-infer-passthrough` solves for inference). This
   is the smallest sidecar that closes that gap without patching NanoClaw.
3. **`src/usage-emitter/`** — a periodic job (not a daemon), mirroring
   `packages/usage-emitter-claude-code`, that tails the agent group's own Claude
   session JSONL on the **host** and reports `usage.incurred` rows with
   `source: 'harness:nanoclaw'`.

Packaging them together, rather than as three separate packages, keeps the one thing
an operator actually deploys — "the NanoClaw instance's Imajin-side surface" — in one
place with one README and one set of env vars.

## No NanoClaw fork

`src/channel-adapter.ts` (and its `src/auth/`, `src/imajin-client.ts`,
`src/dispatch.ts`, `src/ws-connection.ts` dependencies) is meant to be **copied** into
a NanoClaw checkout's `src/channels/imajin-chat.ts`, with one barrel-import line
appended to `src/channels/index.ts` — exactly the install shape every real
`/add-<channel>` skill uses (verified against a clone of `qwibitai/nanoclaw`,
2026-09-02 push). Nothing here is committed to, or modifies, `qwibitai/nanoclaw`
itself. `packages/claw-envelope`'s NanoClaw renderer emits the exact `APPLY.md`
directive doc for this.

## Identity and reply semantics

The channel adapter authenticates as the agent's **own** DID (Ed25519
challenge-response, `src/auth/challenge-response.ts` — ported pattern from
`openclaw-imajin-plugin/src/ws-service.ts`, a separate repo/package) and never sends
an `X-Acting-For` header when replying. That is structurally identical to
`onBehalfOf: "self"` ([imajin-ai#1545](https://github.com/ima-jin/imajin-ai/issues/1545)):
the agent replies as itself, not on the owner's behalf.

## Environment variables (names only)

| Variable | Used by | Purpose |
|---|---|---|
| `KERNEL_BASE_URL` | adapter, mcp-proxy, usage-emitter | Base URL of the kernel |
| `NANOCLAW_AGENT_DID` | adapter, mcp-proxy | This instance's agent DID |
| `NANOCLAW_AGENT_KEYPAIR_PATH` | adapter, mcp-proxy | Path to the 0600 keypair file (`bootstrap-identity.ts` writes this) |
| `MCP_PROXY_HOST` / `MCP_PROXY_PORT` | mcp-proxy | Loopback bind address (default `127.0.0.1:8788`) |
| `MCP_SERVER_URL` | mcp-proxy | Real MCP server (default `https://mcp.imajin.ai`) |
| `MCP_PROXY_ATTESTATION_ID` | mcp-proxy | The `app.authorized` attestation granting MCP scope — owner consent step, minted once |
| `USAGE_EMIT_TOKEN` | usage-emitter | App-service token carrying `usage:emit` (serviceEligible, see `@imajin/auth`'s `SCOPE_VOCABULARY`) |
| `NANOCLAW_PROJECTS_DIR` | usage-emitter | Host path to the agent group's `.claude-shared/projects/` |
| `USAGE_EMITTER_STATE_FILE` | usage-emitter | Where the tail cursor is persisted |

## One-time setup: register the usage emitter

Like `packages/usage-emitter-claude-code`, emitter registration is an **owner**
action (`usage:emitters-manage` is owner-only by construction), not something this
package's identity bootstrap performs:

```bash
curl -X PUT "$KERNEL_URL/usage/api/emitters" \
  -H "Authorization: Bearer $OWNER_SESSION_OR_APP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "source": "harness:nanoclaw", "reader": "tail-jsonl", "cadence": "periodic", "actingFor": "<owner-did>" }'
```

## Development

```bash
pnpm --filter @imajin/nanoclaw-imajin-channel typecheck
pnpm --filter @imajin/nanoclaw-imajin-channel lint
pnpm --filter @imajin/nanoclaw-imajin-channel test
pnpm --filter @imajin/nanoclaw-imajin-channel mcp-proxy      # tsx src/mcp-proxy/server.ts
pnpm --filter @imajin/nanoclaw-imajin-channel usage-emitter  # tsx src/usage-emitter/index.ts
```
