# Imajin

**You compose. Imajin orchestrates. Signed. Legible.**
*Imajin — programmable trust. The speed of thought, signed.*

You send a voice note, take a photo, drop a file. Your agent works out what you meant and does it on your behalf — and you decide what leaves your hands before anything does. Every step is signed, so the record of what happened is yours to read, check, and keep. The machinery recedes; the proof remains.

[See it live](https://imajin.ai) · Source-available under the [Imajin Network License](./LICENSE.md) — not MIT. Self-hostable: your data, your keys, your domain.

---

## What it is

The kernel is six primitives — **Attestation · Communication · Attribution (`.fair`) · Settlement · Discovery · Revocation** — plus the rails that serve them: auth, pay, registry, connections, chat, media, the event bus, and the vault.

- **Attestation** — every trust-relevant act is a signed, append-only record. Unsigned attestations are rejected at write.
- **Communication** — DID-addressed messaging, scoped by identity type.
- **Attribution (`.fair`)** — every asset carries a signed manifest of who contributed what, in what proportion.
- **Settlement** — transactions verify `.fair` signatures before money moves.
- **Discovery** — a registry of identities and apps, plus selective disclosure for what a node reveals to whom.
- **Revocation** — the option to leave: withdraw, tombstone, or hard-destroy. Propagation is part of the primitive.

**Proof of history, not proof of work.** Imajin doesn't burn electricity to win a lottery; it keeps a signed, append-only record of real things that happened, and the value is in the record. The rest is in the [MJN Whitepaper](./docs/mjn-whitepaper.md).

## What you can do today

As of 2026-10-05. Each line below is something you can do on a node running this repo's kernel; the dated detail and PR links are in the [build log](./apps/kernel/content/build-log.md) (September 2026 entry) and the [process log](./apps/kernel/content/process-log.md).

- **Hold your own identity.** Create a DID, keep your keys, and recover them with recovery codes — shipped September 2026. Production registration is invite-only.
- **Bring your own model.** Seal your own provider key — Anthropic, OpenAI, Gemini, xAI, Moonshot, Z.ai, OpenRouter, or any OpenAI-compatible local endpoint — and route your agent's completions through the kernel's inference passthrough ([kernel README](./apps/kernel/README.md#inference-connectors)).
- **Connect your tools.** Authorize Google Workspace (connector v1, September 2026) with a sealed refresh token you can revoke from either side.
- **Lend a credential without giving it away.** Grant an agent a scoped, one-time-use credential from your vault, and revoke it in one tap from `/jin` — September 2026.
- **Read what your agents spent.** Every node serves a public, signed per-DID usage rollup at `GET /usage/api/rollup/{did}/latest` ([#2030](https://github.com/ima-jin/imajin-ai/issues/2030)) — a receipt you can verify, not a number we assert.
- **Move money you can account for.** Request, send, top up, and withdraw through the kernel's MJN/MJNx ledger, with Stripe reconciled against it (September 2026).
- **Check the record.** Resolve a `did:imajin` publicly ([RFC-40](./docs/rfcs/RFC-40-did-imajin-resolution.md); [#1443](https://github.com/ima-jin/imajin-ai/issues/1443) closed 2026-07-28) and read the durable audit log ([#1140](https://github.com/ima-jin/imajin-ai/issues/1140) closed 2026-07-30).
- **Use apps built on Imajin.** Sell tickets, run a survey, take a course — see [Kernel vs. apps](#kernel-vs-apps).
- **Build one.** Register an app as an identity and have the kernel serve it — see [Build an app](#build-an-app).

## Kernel vs. apps

The kernel is the six primitives (Attestation · Communication · Attribution · Settlement · Discovery · Revocation) and the rails that serve them; everything else is a third-party service that the kernel serves under the registered-app contract ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981)). A node operator runs the kernel, not a calendar. These are **apps built on Imajin**, each registered as an identity ([#1990](https://github.com/ima-jin/imajin-ai/issues/1990), closed 2026-09-14), each documenting itself in a README it owns.

Extraction into separate repos is in progress, not finished ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981) is still open): the apps below still live in this monorepo and run beside the kernel. `links` was the first to leave — `apps/links` was pruned on 2026-09-28 and it now lives at [ima-jin/links](https://github.com/ima-jin/links).

<!-- apps:start -->
| App | What it does | Docs |
|---|---|---|
| [broker-agent](./apps/broker-agent) | Telegram broker agent — conversational surface for broker-mediated social coordination | [README](./apps/broker-agent/README.md) |
| [corpus](./apps/corpus) | Per-DID corpus indexing and BM25 search service — an internal daemon (port 8003 in production), not a subdomain web app | [README](./apps/corpus/README.md) |
| [events](./apps/events) | Create events. Sell tickets. Own your audience | [README](./apps/events/README.md) |
<!-- apps:end -->

**learn** ([#2503](https://github.com/ima-jin/imajin-ai/issues/2503)) has left this monorepo: it lives in its own repo, [ima-jin/learn](https://github.com/ima-jin/learn), registered through the app contract and still served at `jin.imajin.ai/learn` via the same Caddy route.

**coffee** ([#1984](https://github.com/ima-jin/imajin-ai/issues/1984), [#2500](https://github.com/ima-jin/imajin-ai/issues/2500)) has left this monorepo: it lives in its own repo, [ima-jin/coffee](https://github.com/ima-jin/coffee), registered through the app contract and still served at `jin.imajin.ai/coffee` via the same Caddy route.

**market** ([#1989](https://github.com/ima-jin/imajin-ai/issues/1989), [#2512](https://github.com/ima-jin/imajin-ai/issues/2512)) has left this monorepo: it lives in its own repo, [ima-jin/market](https://github.com/ima-jin/market), registered through the app contract and still served at `jin.imajin.ai/market` via the same Caddy route.

**dykil** ([#1985](https://github.com/ima-jin/imajin-ai/issues/1985), [#2523](https://github.com/ima-jin/imajin-ai/issues/2523)) has left this monorepo: it lives in its own repo, [ima-jin/dykil](https://github.com/ima-jin/dykil), registered through the app contract and still served at `jin.imajin.ai/dykil` via the same Caddy route.

`apps/kernel` is the kernel service itself, not an app — see its [README](./apps/kernel/README.md). Whether `broker-agent` and `corpus` are kernel rails or apps is undecided ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981), [#1726](https://github.com/ima-jin/imajin-ai/issues/1726)).

## Build an app

An app registers with the kernel as an identity, gets scoped tokens, and never reaches into kernel internals. Fork [imajin-app-template](https://github.com/ima-jin/imajin-app-template) — it carries the contract, the CI gates, and the agent rules a registered app needs. Registration mechanics: [docs/REGISTRATION.md](./docs/REGISTRATION.md) — including how an app emits events through `POST /api/events` (an operator-approved allowlist; notify and audit only, never money). The contract itself: [#1981](https://github.com/ima-jin/imajin-ai/issues/1981).

The SDK packages an app needs (all four install from npm today — see [Packages](#packages-sdk)):

- [`@imajin/auth-client`](./packages/auth-client) — "Sign in with Imajin": sessions and ready-made Next.js route handlers.
- [`@imajin/auth`](./packages/auth) — signing, verification, and scoped app-token guards.
- [`@imajin/config`](./packages/config) — CORS, service routing, session config.
- [`@imajin/fair`](./packages/fair) — `.fair` attribution types and validator.

Packages publish under the `@ima-jin` scope, not `@imajin` — npm doesn't recognize the scope this repo imports from, so [`scripts/prepare-npm-publish.mjs`](./scripts/prepare-npm-publish.mjs) rewrites it at publish time. Details: [docs/packages/PUBLISHING.md](./docs/packages/PUBLISHING.md).

Apps built on Imajin in their own repos: [imajin-karaoke](https://github.com/ima-jin/imajin-karaoke), [imajin-fixready](https://github.com/ima-jin/imajin-fixready), [imajin-scorecard](https://github.com/ima-jin/imajin-scorecard).

## Packages (SDK)

<!-- packages:start -->
Generated from `packages/*/package.json` and the live npm registry, 2026-10-05. **10 of 29 packages are published** and install anonymously from npmjs.org with `npm install @ima-jin/<name>`; the rest are workspace-only (depended on via `workspace:*` inside this monorepo). Every `package.json` in the repo stays `private: true` as a publish safety net ([docs/npm-publishing.md](./docs/npm-publishing.md)), so the manifest flag is not the status — the registry is. Packages publish under `@ima-jin`, never `@imajin`.

Publish history: SDK publish [#1982](https://github.com/ima-jin/imajin-ai/issues/1982), build + dist exports [#1011](https://github.com/ima-jin/imajin-ai/issues/1011), and the `auth` database removal [#1992](https://github.com/ima-jin/imajin-ai/issues/1992) are closed. Normalizing the remaining packages for npm, [#1581](https://github.com/ima-jin/imajin-ai/issues/1581), is still open. Install notes: [docs/packages/PUBLISHING.md](./docs/packages/PUBLISHING.md).

| Package | What it does | Published |
|---|---|---|
| [`@imajin/auth`](./packages/auth) | Ed25519 keypairs, DID + session/app-token auth guards, permission tiers | npm — `npm install @ima-jin/auth` |
| [`@imajin/auth-client`](./packages/auth-client) | "Sign in with Imajin" SDK — JWT sessions, ready-made Next.js route handlers | npm — `npm install @ima-jin/auth-client` |
| [`@imajin/bus`](./packages/bus) | Event bus: publish → reactor chain (attestation, mjn, settle, notify, emit, webhook) | Workspace-only |
| [`@imajin/chat`](./packages/chat) | Chat UI components — orchestrator, message bubble, voice, media | Workspace-only |
| [`@imajin/cid`](./packages/cid) | Deterministic CIDv1 (dag-cbor + SHA-256) content addressing | npm — `npm install @ima-jin/cid` |
| [`@imajin/config`](./packages/config) | Shared service config — CORS, routing, sessions, handle validation | npm — `npm install @ima-jin/config` |
| [`@imajin/db`](./packages/db) | Shared Postgres handle (postgres-js + Drizzle ORM) | npm — `npm install @ima-jin/db` |
| [`@imajin/dfos`](./packages/dfos) | DFOS protocol bridge — content publish, chain signer, relay | Workspace-only |
| [`@imajin/email`](./packages/email) | Email sending (SendGrid), templates, QR generation | Workspace-only |
| [`@imajin/emit`](./packages/emit) | Fire-and-forget system-event emission (audit/telemetry sink) | Workspace-only |
| [`eslint-config-imajin`](./packages/eslint-config-imajin) | Shared ESLint flat config for the monorepo | Workspace-only |
| [`@imajin/fair`](./packages/fair) | .fair attribution types, validator, builder, React components | npm — `npm install @ima-jin/fair` |
| [`@imajin/input`](./packages/input) | Input components — emoji, voice, GPS, file upload | Workspace-only |
| [`@imajin/llm`](./packages/llm) | LLM inference abstraction — cost tracking, provider routing | Workspace-only |
| [`@imajin/logger`](./packages/logger) | Structured logging (pino-backed) and request middleware | npm — `npm install @ima-jin/logger` |
| [`@imajin/media`](./packages/media) | Media browser and asset display components | Workspace-only |
| [`@imajin/money`](./packages/money) | Currency-safe Money type, signed FX snapshots, ECB rate cache | Workspace-only |
| [`@imajin/notify`](./packages/notify) | Cross-channel notification client (email/in-app/chat) | Workspace-only |
| [`@imajin/onboard`](./packages/onboard) | Anonymous-to-soft-DID onboarding (<OnboardGate>) | Workspace-only |
| [`@imajin/tokens`](./packages/tokens) | Design tokens (DTCG format, Style Dictionary v4) | npm — `npm install @ima-jin/tokens` |
| [`@imajin/trust-graph`](./packages/trust-graph) | Trust graph queries — pod membership, trust distance/radius | Workspace-only |
| [`@imajin/ui`](./packages/ui) | Shared UI — nav bar, identity management, app launcher, theming | npm — `npm install @ima-jin/ui` |
| [`@imajin/vault-core`](./packages/vault-core) | Vault entry models — sealing, delegation, integrity verification | npm — `npm install @ima-jin/vault-core` |
<!-- packages:end -->

### Plugin surface (OpenClaw)

The packages that let an OpenClaw or Claude Code agent act as a kernel-registered identity.

<!-- plugin:start -->
None of these are published to npm yet — all workspace-only (checked against the registry, 2026-10-05).

| Package | What it does | Published |
|---|---|---|
| [`@imajin/claw-envelope`](./packages/claw-envelope) | Harness-agnostic context-envelope generator, plus the agent identity bootstrap CLI | Workspace-only |
| [`@imajin/claw-provisioner`](./packages/claw-provisioner) | Operator-executed runner that materializes an envelope and boots the deploy stack | Workspace-only |
| [`@imajin/nanoclaw-imajin-channel`](./packages/nanoclaw-imajin-channel) | NanoClaw channel adapter — bridges jin.imajin.ai chat to an agent's own DID | Workspace-only |
| [`@imajin/openclaw-infer-passthrough`](./packages/openclaw-infer-passthrough) | Local OpenAI-compatible proxy — mints kernel app-tokens, forwards inference calls to the kernel | Workspace-only |
| [`@imajin/openclaw-reflex-guard`](./packages/openclaw-reflex-guard) | OpenClaw post-turn instruction-check guard (sealed-term + fuzzy reflex) | Workspace-only |
| [`@imajin/usage-emitter-claude-code`](./packages/usage-emitter-claude-code) | Reference usage.incurred emitter — tails a Claude Code session log, posts it to the kernel | Workspace-only |
<!-- plugin:end -->

## Run a node

The kernel only. Apps run separately; each has its own README.

```bash
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai
bash scripts/setup-local.sh
pnpm --filter @imajin/kernel dev   # http://localhost:3000
```

`setup-local.sh` installs dependencies, creates the `imajin_dev` database, wires `.env.local`, runs migrations, and disables the invite gate **for local dev only** — production registration is invite-only. Full guide: [docs/DEVELOPER.md](./docs/DEVELOPER.md). Deployment topology: [docs/ENVIRONMENTS.md](./docs/ENVIRONMENTS.md).

## Project status

<!-- stats:start -->
| Metric | Value | Method |
|---|---|---|
| Codebase | 450,950 lines (`.ts`/`.tsx`) | `git ls-files '*.ts' '*.tsx' \| xargs cat \| wc -l` |
| Commits | 4,579 | `git rev-list --count HEAD` |
| First commit | 2026-02-11 | `git log --reverse --format=%ad --date=short` |
| Services | the kernel + 3 apps built on Imajin, 29 shared packages | `ls apps`, `ls packages` |

_As of commit `5d278d72` (2026-10-05). Regenerated at each replay of [#2028](https://github.com/ima-jin/imajin-ai/issues/2028)._
<!-- stats:end -->

Identities and inference cost aren't typed into this README. There's no public identity-count endpoint. For inference cost, read the signed `usage.rollup` receipt at `GET /usage/api/rollup/{did}/latest` ([#2030](https://github.com/ima-jin/imajin-ai/issues/2030)) — this README doesn't assert a dollar figure it can't sign.

## Docs, RFCs, spec

| Doc | What it covers |
|---|---|
| [MJN Whitepaper](./docs/mjn-whitepaper.md) | The protocol: Attestation · Communication · Attribution · Settlement · Discovery · Revocation, the cryptographic stack, the infrastructure layers |
| [RFC index](./docs/rfcs/INDEX.md) | All RFCs, including the conformance suite ([RFC-21](./docs/rfcs/RFC-21-imajin-conformance-suite.md), tracked in [#1287](https://github.com/ima-jin/imajin-ai/issues/1287)) |
| [Developer Guide](./docs/DEVELOPER.md) | Local setup, env vars, workflows |
| [Environments](./docs/ENVIRONMENTS.md) | Database and deployment topology |
| [Migrations](./docs/MIGRATIONS.md) | The database migration system |
| [Build log](./apps/kernel/content/build-log.md) · [Process log](./apps/kernel/content/process-log.md) | What merged, and how decisions were made |

This repository is the Imajin Inc. reference implementation of the MJN protocol, not the protocol spec itself. The method and spec work is scoped to move toward a separate protocol entity over time — the "two-entity" split referenced in [RFC-40](./docs/rfcs/RFC-40-did-imajin-resolution.md) §10 and the RFC-20/21 conformance framing. That split is still evolving; the RFC index is the canonical pointer.

## Contributing

This is early. The architecture is stabilizing but APIs will change.

If you want to run your own node or build on the stack, start with the [Developer Guide](./docs/DEVELOPER.md), then open an issue or find us on [DFOS](https://app.dfos.com/j/c3rff6e96e4ca9hncc43en).

**Talk to us first.** Before requesting assignment on issues, claiming work, or submitting PRs — come find us on DFOS and introduce yourself. No drive-by PRs: unsolicited PRs from accounts with no prior conversation will be closed. Bot accounts and automated "/apply" comments will be deleted and blocked.

## Security

Found a vulnerability, or want to know what we do and don't guarantee yet? See [SECURITY.md](SECURITY.md) for the responsible-disclosure process and an honest list of known limitations. We're pre-1.0 sovereign plumbing — not claiming to be unhackable, just claiming to be honest about where we are.

## A note on use

Imajin is source-available under the [Imajin Network License](./LICENSE.md). We're not going to stop you — the license means what it says, run it for anything you like within its terms. That's the point of a sovereign system.

But know what you're running. Imajin signs everything. Every action leaves an attributable, non-repudiable record — that's not a feature we bolted on, it's the whole thesis. For two thousand years the money was in the lie; Imajin is built so that hiding stops paying and disclosure starts.

So we'll be honest about the uses we don't jive with: surveillance, targeting, anything built to act on people in the dark. We're not going to forbid them. We're going to do something we think is stronger — make them *legible*. If you use this system to do something you'd rather not have on the record, understand that the system's job is to put it on the record. That's not a bug we'll fix for you.

We hold ourselves to the same thing. Imajin is built in the open, its actions signed, its history auditable — including ours. This is the ethical promise; [LICENSE.md](./LICENSE.md) is what's actually enforceable. We're prepared to be on the record. That's the deal we're offering everyone else, and we took it first.

Two gaps this promise depended on are closed, and dated: anyone can resolve our DIDs without asking us ([RFC-40](./docs/rfcs/RFC-40-did-imajin-resolution.md); [#1443](https://github.com/ima-jin/imajin-ai/issues/1443) closed 2026-07-28), and actions are persisted to a durable audit log rather than only emitted ([#1140](https://github.com/ima-jin/imajin-ai/issues/1140) closed 2026-07-30). The tracking issue, [#1427](https://github.com/ima-jin/imajin-ai/issues/1427), closed 2026-09-23.

Have at it. Careful what you wish for.

## License

[Imajin Network License (INL) v1.0](./LICENSE.md) — **not MIT.** Free to use, copy, modify, and sell for personal use, non-commercial use, small businesses, and 90-day evaluation. Organizations with over CAD $1,000,000 annual revenue doing commercial use must additionally run a Node Identity, produce `.fair` attribution manifests for what they process, and stay protocol-conformant — participation, not a fee. Read [LICENSE.md](./LICENSE.md) for the full terms.

---

*Built by [Imajin](https://imajin.ai) — 今人 (ima-jin) — "now-person" / "imagination"*
