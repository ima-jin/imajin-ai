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
- `docker-compose.yml` — wires the three containers together.
- `.env.example` — variable **names** only.

## Before building

1. Render the envelope: `pnpm --filter @imajin/claw-envelope render -- --harness
   nanoclaw --agent-did <did> --owner-did <did> --handle <name> --out ./rendered`.
2. Stage `./rendered/nanoclaw/groups/<folder>/` into `deploy/nanoclaw/rendered/groups/`
   and the channel adapter source into
   `deploy/nanoclaw/rendered/nanoclaw-channel/` (see `./rendered/nanoclaw/APPLY.md`
   for the exact file list).
3. Copy `.env.example` to `.env` and fill in real values.

Then `docker compose build && docker compose up -d`. Full runbook (identity bootstrap,
verification, rollback) is in `docs/agents/nanoclaw-first-boot.md`.
