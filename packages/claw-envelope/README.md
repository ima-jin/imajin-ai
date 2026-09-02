# @imajin/claw-envelope

Harness-agnostic RFC-31 v2 (#1758) context-envelope generator, built for the first
hand-built NanoClaw instance ([#1932](https://github.com/ima-jin/imajin-ai/issues/1932))
and the provisioner it informs ([#1933](https://github.com/ima-jin/imajin-ai/issues/1933)).

## What it does

1. `generateEnvelope(input)` (`src/generate.ts`) — pure function: agent DID + owner DID +
   intent (scopes, bus routes, brain choice) in, a harness-agnostic `ContextEnvelope` out
   (workspace files, config, delegation-grant *references* — never raw secrets, bus routes).
   Requested scopes are validated against `@imajin/auth`'s closed `GRANT_SCOPE_REGISTRY`
   up front, so a typo fails loudly at generation time.
2. `renderNanoClaw(envelope)` (`src/renderers/nanoclaw.ts`) — maps that envelope onto
   NanoClaw's **actual** on-disk layout, verified against a clone of `qwibitai/nanoclaw`
   (2026-09-02 push), not assumed. See the file's own header comment for the exact mapping
   and why it differs from RFC-31's OpenClaw-shaped naming (NanoClaw's real persona surface
   is one file, `groups/<folder>/instructions.prepend.md`, not separate `SOUL.md`/`AGENTS.md`
   files inside the checkout).
3. `src/cli.ts` — `pnpm --filter @imajin/claw-envelope render -- --harness nanoclaw
   --agent-did <did> --owner-did <did> --handle <name> --out <dir>` writes the rendered tree
   to disk.
4. `src/bootstrap-identity.ts` — the agent identity bootstrap CLI (#1932 scope item 1):
   calls the kernel's *existing* `POST /auth/api/agents` (mints the keypair, wires
   `identity_members` — this script does not reinvent either), then `POST /auth/api/grants`
   with minimal capabilities from the same closed registry. Supports `--dry-run` (prints the
   exact calls it would make; no network access). The returned keypair is written to a local
   file path (0600) and never logged.

## Why no NanoClaw fork

This package renders files and an `APPLY.md` directive doc — the same shape every real
NanoClaw `/add-<channel>` skill uses to install a channel. Applying the output is a copy +
one barrel-import line + rebuild against an upstream NanoClaw checkout, never a change
committed to `qwibitai/nanoclaw` itself.

## Usage

```bash
pnpm --filter @imajin/claw-envelope render -- \
  --harness nanoclaw \
  --agent-did did:imajin:agent-nanoclaw-poc \
  --owner-did did:imajin:owner-ryan \
  --handle nanoclaw-poc \
  --out ./rendered

pnpm --filter @imajin/claw-envelope bootstrap-identity -- --dry-run --handle nanoclaw-poc
```

## Development

```bash
pnpm --filter @imajin/claw-envelope typecheck
pnpm --filter @imajin/claw-envelope lint
pnpm --filter @imajin/claw-envelope test
```
