# NanoClaw first boot — design, harvested checklist, and runbook

Refs [#1932](https://github.com/ima-jin/imajin-ai/issues/1932) (this instance),
[#1933](https://github.com/ima-jin/imajin-ai/issues/1933) (the provisioner this
hand-build informs), [#1758](https://github.com/ima-jin/imajin-ai/issues/1758)
(RFC-31 v2), [#1545](https://github.com/ima-jin/imajin-ai/issues/1545)
(`onBehalfOf: self`), [#1922](https://github.com/ima-jin/imajin-ai/issues/1922) /
[#1925](https://github.com/ima-jin/imajin-ai/issues/1925) (kernel inference
passthrough), [#1957](https://github.com/ima-jin/imajin-ai/issues/1957) (local
inference connector).

## 1. Problem and scope

#1932 asks for the first hand-built NanoClaw instance living inside an Imajin
context: its own agent DID, reachable by DM at its own agent DID in `jin.imajin.ai`
through the **existing** Imajin chat channel (no new UI), tools via `mcp.imajin.ai`
under minimal grants, and per-turn usage attributed even at $0. The brain (local vs
hosted) is an explicit build decision, not the premise (the issue's 2026-09-02
re-alignment banner). This doc is the primary output the hand-build is *for*: the
harvested checklist below is what #1933's provisioner needs to automate.

**Hard rule honored throughout**: no fork of `qwibitai/nanoclaw`. Every piece below
either uses a documented NanoClaw extension seam (the channel-adapter/barrel-import
pattern every real `/add-<channel>` skill uses) or is a small sidecar process next to
it, never a patch to its source tree.

## 2. Step 0 research — how NanoClaw actually works today

Verified against a clone of `qwibitai/nanoclaw` (pushed 2026-09-02), not assumed:

- **Channels are never shipped in trunk.** `src/channels/index.ts` is a
  self-registration barrel (`import './x.js'` per channel); real channels are
  copied in by `/add-<channel>` skills from a sibling `channels` branch. A channel
  implements the `ChannelAdapter` interface (`src/channels/adapter.ts`) directly, or
  wraps a third-party `chat` SDK adapter via `createChatSdkBridge`. Imajin chat is
  neither Discord/Slack/Telegram/etc., so this instance implements `ChannelAdapter`
  directly — copied in the same way, not a fork.
- **Container boot**: `src/container-runner.ts` materializes
  `groups/<folder>/container.json` (`RunnerConfig` in
  `container/agent-runner/src/config.ts`) per agent group, mounts it read-only into
  the container at `/workspace/agent/container.json`, and the agent-runner
  (`container/agent-runner/src/index.ts`) reads `provider`, `assistantName`,
  `mcpServers`, `model`, `effort` from it. `mcpServers` entries are either
  `{ type: 'stdio', command, args, env }` or `{ type: 'http', url, headers? }` — the
  `http` shape carries only **static** headers.
- **Persona/memory surface**: NOT separate `SOUL.md`/`AGENTS.md`/`MEMORY.md` files —
  NanoClaw's real surface is one file, `groups/<folder>/instructions.prepend.md`
  (`PERSONA_PREPEND_FILE`, `src/group-persona.ts`), prepended into the composed
  `CLAUDE.md` every spawn, plus a `memory/` directory convention
  (`project-doc-compose.ts`'s `COMPOSED_HEADER`). RFC-31's envelope borrowed its
  filenames from OpenClaw's reference lump (#1758's own comment on this), not from
  NanoClaw — the two harnesses genuinely differ here, which is exactly the kind of
  seam this hand-build exists to find.
- **Brain wiring**: `container/agent-runner/src/index.ts` constructs the Claude
  provider with `env: { ...process.env }` — the FULL container process environment
  is forwarded into the `@anthropic-ai/claude-agent-sdk` `query()` call, which spawns
  the Claude Code CLI. The CLI honors the standard Anthropic env vars
  (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`) with zero NanoClaw code changes needed.
- **The wire-format gap**: the kernel's completions passthrough (#1925,
  `POST /infer/v1/chat/completions`) is OpenAI-compatible. `ANTHROPIC_BASE_URL`
  expects the Anthropic Messages API (`/v1/messages`) wire format. These do not
  interoperate — see §4.
- **Identity**: the kernel already has a working agent-registration primitive,
  `POST /auth/api/agents` (`apps/kernel/app/auth/api/agents/route.ts`) — mints an
  Ed25519 keypair server-side, creates the `identities` row
  (`scope: 'actor', subtype: 'agent'`), and both `identity_members` rows (owner +
  reverse `role: 'agent'`) in one transaction. This is the existing flow Jin's own
  agent DID was registered through; this hand-build reuses it via
  `packages/claw-envelope`'s `bootstrap-identity.ts`, not a new endpoint.
- **Grants**: `POST /auth/api/grants` (#1882) issues scoped delegation from a closed
  capability registry (`@imajin/auth`'s `GRANT_SCOPE_REGISTRY` — `messages:read`,
  `messages:write`, `discovery:read`, etc.). This, not a new grant type, is what
  "minimal grants" means for this instance (#1922 finding 5: "use-not-see already
  works structurally... no new grant type is needed").
- **The reference auth pattern**: `openclaw-imajin-plugin/src/ws-service.ts` +
  `src/chat.ts` (a separate OpenClaw plugin repo) is the reference implementation for
  "speak to the kernel as an agent": Ed25519 challenge-response
  (`POST /auth/api/login/challenge` → sign → `POST /auth/api/login/verify` → session
  cookie), a persistent authenticated WS to `/chat/ws`, and
  `POST /chat/api/d/:did/messages` to send. `packages/nanoclaw-imajin-channel`
  re-implements this same protocol (a different repo/language surface, not an
  importable dependency).
- **Usage precedent**: `packages/usage-emitter-claude-code` is the exact reference
  shape #1151 wants for "external emitter, source e.g. `harness:nanoclaw`": tail
  Claude Code's own session JSONL, map `message.usage` to a `usage.incurred` row,
  POST batched to `/usage/api/incurred`, dedupe via `external_id`. NanoClaw's Claude
  provider writes the identical JSONL format under a host-bind-mounted
  `.claude-shared/projects/` directory per agent group
  (`container-runner.ts`'s `buildMounts`), so the same tailing approach applies,
  pointed at that host path.

## 3. Architecture

```mermaid
flowchart LR
  Owner["Owner (Ryan)"] -->|DM in jin.imajin.ai| Kernel["Imajin kernel"]
  Kernel -->|chat.message.received / WS /chat/ws| Bridge["imajin-chat ChannelAdapter\n(packages/nanoclaw-imajin-channel)"]
  Bridge -->|onInbound| NanoClaw["NanoClaw host process"]
  NanoClaw -->|spawns| AgentContainer["Per-conversation agent container\n(Claude Agent SDK)"]
  AgentContainer -->|MCP over loopback| McpProxy["mcp-proxy sidecar\n(token mint/refresh)"]
  McpProxy -->|Bearer app-token| MCP["mcp.imajin.ai"]
  AgentContainer -.->|direct Anthropic key\n(deviation, see #4)| Anthropic["Anthropic API"]
  AgentContainer -->|writes| SessionJsonl[".claude-shared/projects/*.jsonl"]
  UsageEmitter["usage-emitter sidecar\n(periodic)"] -->|tails| SessionJsonl
  UsageEmitter -->|POST /usage/api/incurred\nsource=harness:nanoclaw| Kernel
  Bridge -->|deliver: POST /chat/api/d/:did/messages\nno X-Acting-For| Kernel
```

The envelope generator (`packages/claw-envelope`) produces the NanoClaw-side
config/workspace files and an `APPLY.md` directive doc; the identity bootstrap CLI
(same package) registers the agent DID and its minimal grant; the bridge package
(`packages/nanoclaw-imajin-channel`) is the channel adapter plus the two sidecars;
`deploy/nanoclaw/` wires it all into one Compose stack.

## 4. Brain-path decision

NanoClaw's Claude provider already honors `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`
via plain container env — no code change needed to point it somewhere other than
`api.anthropic.com`. But the kernel's only completions passthrough today (#1925) is
OpenAI-compatible (`/infer/v1/chat/completions`); the Anthropic Messages API
(`/v1/messages`) that `ANTHROPIC_BASE_URL` expects is a different wire format
entirely. Pointing NanoClaw at the kernel passthrough today would send
Anthropic-shaped requests to an OpenAI-shaped endpoint and fail outright.

**Decision**: file a follow-up issue under #1922 proposing an Anthropic-format
passthrough (`/infer/v1/messages`, mirroring #1925's own auth/metering contract) —
filed as [#1959](https://github.com/ima-jin/imajin-ai/issues/1959). **For this POC**, run on a scoped **direct**
Anthropic API key supplied via container env (`DIRECT_BRAIN_API_KEY` /
`ANTHROPIC_API_KEY`), never committed. This is an explicit, documented deviation from
the kernel's sealed-connector path, closed by that follow-up — not a silent
workaround.

Placement: hosted (the direct key lives on the deploy host's container env). Local
placement (Ollama/vLLM via the #1957 local-inference connector) is a valid future
swap this same envelope shape supports without a code change — only the
`model.placement`/`model.provider`/`model.deviation` fields in
`packages/claw-envelope`'s `EnvelopeConfig` change.

## 5. Harvested checklist (for #1933)

Every manual step taken end-to-end to get from "nothing" to "bootable instance",
in order. This is the primary artifact #1933's provisioner needs.

1. **Clone NanoClaw at a pinned commit.** — *Automatable* (Dockerfile `ARG
   NANOCLAW_GIT_REF`; the provisioner would pin and record the commit).
2. **Register the agent DID.** — *Automatable*: `packages/claw-envelope`'s
   `bootstrap-identity.ts` calls the kernel's existing `POST /auth/api/agents`.
3. **Issue the minimal delegation grant.** — *Automatable*: same script, `POST
   /auth/api/grants` with capabilities from the closed registry.
4. **Store the returned keypair securely (0600, never logged).** — *Automatable*:
   done by the same script.
5. **Render the envelope (persona, `container.json`, env template, `APPLY.md`).** —
   *Automatable*: `packages/claw-envelope`'s `render` CLI.
6. **Copy the channel adapter into a NanoClaw checkout + append the barrel import.**
   — *Automatable*: scripted in `deploy/nanoclaw/Dockerfile`'s build stage today;
   #1933's provisioner should do this as a templated step rather than a Dockerfile
   `COPY`, once more than one harness needs it.
7. **Mint the `app.authorized` attestation granting the mcp-proxy app DID MCP
   scope.** — **Manual, and likely to stay manual**: this is an owner-consent step
   (the human approving "this app may act for me on MCP") — the same class of step
   #1922's own design treats as a deliberate, separately-reviewed decision, not an
   automation target.
8. **Register the usage emitter (`PUT /usage/api/emitters`, source
   `harness:nanoclaw`).** — *Automatable in principle*, but deliberately left as an
   **owner** action here (mirrors `packages/usage-emitter-claude-code`'s own README):
   the emitter registry is owner-only by construction, so a provisioner acting *as*
   the agent could never do this step even if it wanted to — it has to be either the
   owner directly, or a future provisioner explicitly granted that authority.
9. **Set the direct Anthropic key as a deviation (§4).** — **Manual, and a deviation
   to close, not to automate**: the correct long-term state is the kernel's sealed
   connector once the Anthropic-format passthrough follow-up
   ([#1959](https://github.com/ima-jin/imajin-ai/issues/1959)) lands; automating the
   deviation would entrench it.
10. **Build and start the containers; verify the DM round trip.** — *Automatable*
    (`docker compose build && up`); verification itself is necessarily manual for a
    first boot (see §6) but is exactly the kind of check a provisioner's health
    surface should encode going forward.
11. **Verify `usage.incurred` rows land with `source: 'harness:nanoclaw'`.** —
    *Automatable* as a scripted check once the emitter has run at least once;
    treated as manual verification here since this task does not touch live infra.

**Summary for #1933**: steps 1–6, 10 (build), and 11 (once scripted) are ready to
fold into the provisioner as-is. Steps 7 and 9 are owner-consent/deviation steps that
should stay explicit gates in the provisioner's flow, not disappear into automation.
Step 8 is a policy choice (owner vs. provisioner-delegated) the provisioner needs to
make deliberately, not default silently.

## 6. Runbook (operator-executed — NOT run by this task)

This task does not deploy anything or touch live infrastructure/config. The
following is for Jin/Ryan to execute on the Imajin server.

### Build

```bash
cd deploy/nanoclaw
cp .env.example .env   # fill in real values
pnpm --filter @imajin/claw-envelope render -- \
  --harness nanoclaw --agent-did <pending, see next step> \
  --owner-did <owner-did> --handle nanoclaw-poc --out ./rendered-tmp
# (agent DID isn't known until after identity registration — render again
#  once bootstrap-identity.ts has run, or pass a placeholder and re-render.)
```

### Register identity

```bash
pnpm --filter @imajin/claw-envelope bootstrap-identity -- \
  --kernel-url "$KERNEL_BASE_URL" \
  --owner-token "$OWNER_SESSION_TOKEN" \
  --handle nanoclaw-poc \
  --audience-dids "$NANOCLAW_OWNER_DID" \
  --keypair-path "$NANOCLAW_AGENT_KEYPAIR_PATH_HOST"
```

Re-run the envelope render with the real agent DID; stage its output into
`deploy/nanoclaw/rendered/` per that directory's README.

### Mint the MCP attestation (owner action, step 7 above)

Via the connectors/apps consent flow on the kernel's own UI — no CLI shortcut exists
by design (owner-consent step).

### Register the usage emitter (owner action, step 8 above)

```bash
curl -X PUT "$KERNEL_BASE_URL/usage/api/emitters" \
  -H "Authorization: Bearer $OWNER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "source": "harness:nanoclaw", "reader": "tail-jsonl", "cadence": "periodic", "actingFor": "'"$NANOCLAW_OWNER_DID"'" }'
```

### Start

```bash
docker compose build
docker compose up -d
```

### Verify DM round trip in jin.imajin.ai

1. Open `jin.imajin.ai`, start a DM with the agent's DID.
2. Send a message; confirm a reply arrives signed by the agent DID (not the owner).
3. Check `mcp-proxy`'s `/healthz` returns `{ ok: true }`.

### Verify usage.incurred rows

```bash
curl -H "Authorization: Bearer $OWNER_SESSION_TOKEN" \
  "$KERNEL_BASE_URL/usage/api/rollups?source=harness:nanoclaw"
```

Confirm rows appear after a test turn, including a $0 turn (attribution is the
point, not billing — imajin-ai#1932).

### Rollback

1. `docker compose down` — stops all three containers; NanoClaw's own agent
   containers are separate and unaffected by this instance's identity.
2. Revoke the delegation grant issued in step 3 (`POST /auth/api/grants` — see the
   kernel's grants API for the revoke path) if the instance is being decommissioned,
   not just paused.
3. Set the usage emitter's `status` to `revoked` via `PUT /usage/api/emitters` if
   decommissioning.
4. The agent DID and its keypair are otherwise inert once the container is stopped —
   no further cleanup is required to "pause" the instance.
