# deploy/nanoclaw

Docker Compose deployment for the first hand-built NanoClaw instance
([imajin-ai#1932](https://github.com/ima-jin/imajin-ai/issues/1932)). This directory
ships build/compose definitions only — **nothing here has been run against live
infrastructure**; the operator (Jin/Ryan) deploys using the runbook in
[`docs/agents/nanoclaw-first-boot.md`](../../docs/agents/nanoclaw-first-boot.md).

## Files

- `Dockerfile` — builds the NanoClaw host process from a pinned upstream commit and
  applies the `imajin-chat` channel (copy + barrel import + rebuild — see the
  Dockerfile's own header comment for why this containerizes a process NanoClaw
  itself ships as a native install).
- `mcp-proxy.Dockerfile` / `usage-emitter.Dockerfile` — the two
  `packages/nanoclaw-imajin-channel` sidecars.
- `infer-passthrough.Dockerfile` — containerizes
  `packages/openclaw-infer-passthrough`'s own existing entry point verbatim
  (imajin-ai#1959/#1961). This is the default brain path: the NanoClaw
  container's `ANTHROPIC_BASE_URL` points here instead of holding a real
  Anthropic key. See "Brain path" below.
- `infer-proxy-routes.example.json` — template for the shim's non-secret
  routes config (one `"anthropic"` entry — NanoClaw needs no other route).
  Copy to `infer-proxy-routes.json` (untracked) and fill in the real
  `principalDid`/`attestationId`.
- `docker-compose.yml` — wires the four containers together.
- `.env.example` — variable **names** only.

## Brain path (imajin-ai#1959/#1961)

The NanoClaw agent container's Claude Agent SDK / Claude Code CLI speak the Anthropic
Messages API natively via `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`. By default those
point at the `infer-passthrough` shim (`ANTHROPIC_BASE_URL=http://infer-passthrough:
${INFER_PROXY_PORT}/anthropic`, `ANTHROPIC_API_KEY=unused-placeholder`) — the shim mints
a kernel app-token and forwards to `POST /infer/v1/messages` on the sealed Anthropic
connector. No provider key ever reaches the NanoClaw container. This closes the
earlier direct-Anthropic-key deviation (superseded historical note in
`docs/agents/nanoclaw-first-boot.md`).

The old direct-key path still exists as an explicit, non-default break-glass escape
hatch (`brain.via: 'direct'` in `packages/claw-envelope`) for a deployment that
deliberately does not want to run the shim sidecar — in that case `ANTHROPIC_API_KEY`
holds a real, scoped key directly and `ANTHROPIC_BASE_URL` is left at its default
(`api.anthropic.com`). This repo's compose file wires the default (shim) path; picking
`'direct'` is a manual compose edit, not a flag.

### Container networking (read this before deploying)

NanoClaw's HOST container spawns its own per-conversation AGENT containers directly
against the host's Docker socket (docker-outside-of-docker) — they are sibling
containers on the host daemon, **not** children of this compose project, and do **not**
automatically share a network namespace or DNS with any compose service. `ANTHROPIC_BASE_URL`
therefore uses the compose **service name** (`infer-passthrough`), never `127.0.0.1`, and
the shim binds `0.0.0.0` internally so it is reachable across containers. For that
service name to actually resolve from inside a spawned AGENT container, whoever wires
NanoClaw's container-spawn call (`container-runner.ts`, out of this deploy's scope) must
attach it to the `nanoclaw-net` network this compose file declares — called out as an
explicit verify step in the harvested checklist, not assumed to already work.

The same caveat applies to `mcp-proxy`'s `127.0.0.1`-based URL baked into the rendered
`container.json` (pre-dating this brain-path change) — verify both at deploy time.

## Before building

1. Render the envelope: `pnpm --filter @imajin/claw-envelope render -- --harness
   nanoclaw --agent-did <did> --owner-did <did> --handle <name> --out ./rendered`.
2. Stage `./rendered/nanoclaw/groups/<folder>/` into `deploy/nanoclaw/rendered/groups/`
   and the channel adapter source into
   `deploy/nanoclaw/rendered/nanoclaw-channel/` (see `./rendered/nanoclaw/APPLY.md`
   for the exact file list).
3. Copy `.env.example` to `.env` and fill in real values.
4. Copy `infer-proxy-routes.example.json` to `infer-proxy-routes.json` and fill in the
   real `principalDid`/`attestationId` for the `"anthropic"` route (requires the
   `app.authorized` attestation from step below).

Then `docker compose build && docker compose up -d`. Full runbook (identity bootstrap,
verification, rollback) is in `docs/agents/nanoclaw-first-boot.md`.
