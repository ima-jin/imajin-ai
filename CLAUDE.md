# Imajin contributor guide

Read [canonical patterns](docs/guide/canonical-patterns.md) before changing a primitive boundary. Reuse the shared auth, identity, settlement, attribution and disclosure helpers rather than implementing route-local copies.

## What this is

Imajin's kernel serves **Attestation · Communication · Attribution · Settlement · Discovery · Revocation** and shared rails. Identity is their subject. The workspace contains the kernel, broker-agent and corpus. Apps built on Imajin own separate repositories, identities and deployment procedures.

## Read as needed

- [Contributor setup](docs/DEVELOPER.md): local setup, builds, environment and database work.
- [Environment configuration](docs/ENVIRONMENTS.md): ports, domains and configuration ownership.
- [PR checklist](docs/PR-CHECKLIST.md): submission requirements.
- [Migration discipline](docs/MIGRATIONS.md): root kernel SQL and app-owned migration boundaries.
- [Known debt](docs/DEBT.md): existing refactor ownership.
- [Design](DESIGN.md): frontend conventions.
- [Canon and RFCs](docs/canon/rfcs/INDEX.md): protocol grammar and explicitly historical records.
- [Root README](README.md): app and package entry points.

## Local setup

Use the documented setup script and a local development database. Start only the kernel when no other workspace service is needed:

```bash
bash scripts/setup-local.sh
pnpm --filter @imajin/kernel dev
```

The kernel has no basePath and listens on port 3000 in local development. Independently owned apps configure their own routing prefixes; do not add removed app workspace filters.

## Code and data boundaries

- Infrastructure packages do not import kernel code. Declare dynamic-import dependencies in the consuming manifest.
- Authenticate through shared primitives. Use verified effective identity for personal and organization contexts, including ownership, names, handles, defaults and labels. Denied act-as never falls back to a personal action.
- App and agent tokens, human sessions, operator approval and member consent are distinct contracts. Check the live service spec rather than inferring authority from a DID selector.
- Services own named Postgres schemas. Never read another app's tables as an integration shortcut.
- Kernel schema changes require idempotent, schema-qualified root SQL above the fixed baseline cut, with an owner declaration. Drizzle can scaffold SQL; its local journal is not runner authority. Never use `drizzle-kit push` or modify applied migrations.
- Retain history. State changes and revocation carry attestations; do not delete rows or repair a ledger by normalizing its recorded checksums.
- Legal-entity and bank-detail reads use dedicated disclosure/custody helpers, not generic media or vault access.
- Corpus GitHub sources use registry-resolved source owners, explicit grants and the owner's OAuth connector, never a node token or personal-connector fallback.

## Configuration and boot

Scripts do not automatically load environment files. Follow each command's documented environment boundary; the kernel uses its Node env-file entrypoint. Do not set `NODE_ENV` manually to work around a failing command.

Public-prefixed variables are inlined at build time. Runtime credential adoption uses typed server-only vault configuration before database/server imports, not credential assignment to `process.env`. Never put secret values in manifests, code, command arguments, tests, logs or PR text.

After updating shared packages, rebuild their outputs and affected apps rather than assuming incremental caches are current. Use the dependency/import conventions in the contributor guide and package manifests.

## Documentation and validation

Consumer docs describe current state and are edited in place. Explain concepts and integration flows, link service specs for route contracts, and keep release/issue history in its dedicated records. Do not append dated capability summaries or generated route catalogues.

While iterating, run affected tests only. The full agent suite is `pnpm --silent test:agent`; build, lint and typecheck have agent output variants. Follow [AGENTS.md](AGENTS.md) for worktree isolation, output discipline and the reviewed release/deploy path.
