# deploy/openclaw

Support for `harness: 'openclaw'`, `placement: 'hosted'` (imajin-ai#2186,
RFC-31 Phase 1). Unlike `deploy/nanoclaw/` (imajin-ai#1932), this directory
does **not** ship a `Dockerfile`/`docker-compose.yml` yet — see "Why no
compose stack here yet" below. `placement: 'local'` is the fully-supported
path today; see `packages/claw-envelope/src/renderers/openclaw.ts`'s
`SETUP.md` output (part of every rendered bundle) for the operator-run
install steps.

## What IS shipped for `openclaw` in this PR

- `packages/claw-envelope`'s `renderOpenClaw()` — the envelope renderer:
  maps a `ContextEnvelope` onto OpenClaw's real workspace shape
  (`AGENTS.md`/`SOUL.md`/`MEMORY.md`/`USER.md`/`memory/`) plus `openclaw.json`
  with the Imajin channel plugin (`openclaw-imajin-plugin`, a sibling repo)
  configured against the minted agent DID + kernel URL — no static keys, the
  same Ed25519 challenge-response auth model as NanoClaw.
- `packages/claw-provisioner`'s runner — supports `harness: 'openclaw'` for
  both placements: `local` renders and writes the bundle (no compose
  involved, ever); `hosted` reuses the exact same `docker compose build && up
  -d` + boot-status-callback code path NanoClaw's hosted placement already
  uses, parameterized by harness (`deploy/openclaw/rendered/<handle>/`,
  `deploy/openclaw/` as the compose dir) — see that package's `runner.ts`.
- The Agent View wizard (`/auth/agents`) — `openclaw` is selectable as a
  harness, and `placement: 'local'` gets the same "Download bundle" action
  NanoClaw's local placements already have.

## Why no compose stack here yet

`deploy/nanoclaw/`'s `Dockerfile` was written against a cloned, inspected
copy of NanoClaw's own upstream repo (`qwibitai/nanoclaw`) — its install
path, build command, and container-spawn mechanism were all verified
directly, not assumed. No equivalent OpenClaw core-source checkout was
available in this task's environment: only `openclaw-imajin-plugin` (the
Imajin plugin FOR OpenClaw) was inspectable, not OpenClaw itself. RFC-31's
own harness-comparison table
(`docs/rfcs/RFC-31-agent-execution-sandbox.md`) already flags this
directly: OpenClaw's headless/gateway mode is listed as "no headless mode
yet (near)" — i.e. not yet a settled, scriptable target as of that RFC's
last update.

Writing a `Dockerfile` that clones/builds/starts OpenClaw without having
verified any of that against a real checkout would repeat exactly the
mistake this repo's own `nanoclaw-first-boot.md` was written to avoid
("verified against a clone... NOT assumed"). Rather than guess at OpenClaw's
install mechanism, packaging format, or headless entrypoint, this PR leaves
the **hosted** compose stack as follow-up work and ships the fully-verified
half instead: the envelope renderer, the runner's generic hosted/local code
paths (already exercised by NanoClaw and now parameterized by harness), and
the wizard. See the PR's DECISION card list for this open call.

## Using `placement: 'hosted'` before this directory has a compose stack

`packages/claw-provisioner`'s runner will still attempt
`docker compose build && up -d` in whatever `--compose-dir` you pass it (or
this directory, by default) — it has no harness-specific branching beyond
selecting the right envelope renderer. Until a real `deploy/openclaw/`
compose stack exists, point `--compose-dir` at your own OpenClaw deployment
scripts, or use `placement: 'local'` and follow the rendered `SETUP.md`
against your own already-running OpenClaw install.

## First-boot doc

See [`docs/agents/openclaw-first-boot.md`](../../docs/agents/openclaw-first-boot.md)
for the full research trail, architecture, and what could/couldn't be
verified end-to-end in this sandbox.
