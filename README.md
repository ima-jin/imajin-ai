# Imajin

**You compose. Imajin orchestrates. Signed. Legible.**
*Imajin — programmable trust. The speed of thought, signed.*

**For 2,000 years the money was in the lie.**

Information asymmetry — I know what you don't, I hide it, I profit from the gap — is the business model under advertising, finance, platforms, and supply chains. The web we got runs on it: value extracted from what you can't see. The dark web is just the honest name for what the whole thing already is underneath.

**Imajin is the light web.** A sovereign, auditable layer where identity, history, and value are things you can *see and own* — not things done to you in the dark. It flips the gradient: honesty becomes the profitable move, because the signed record *is* the value. Hiding stops paying; disclosure starts. Be honest. Make money. The human is centered not as a slogan but as a consequence — a system that can't profit by lying to you has to serve you.

You do a human thing — send a voice note, take a photo, drop a file. An agent figures out what you meant, does it on your behalf, asks before anything leaves your hands, and signs a record of what it did. The machinery recedes; the proof remains.

[See it live](https://imajin.ai) · [Buy us a coffee](https://jin.imajin.ai/coffee/veteze) — a real, self-hosted app running on this stack.

Licensed under the [Imajin Network License](./LICENSE.md) — not MIT. Self-hostable. Your data, your keys, your domain. See [Project Status](#project-status) for what "real and running" means today.

---

## What it is

The kernel is six primitives — **Attestation · Communication · Attribution (`.fair`) · Settlement · Discovery · Revocation** — plus the rails that serve them: the event bus, the vault, media/attribution surfaces, and the OpenClaw connector layer. A node operator runs the kernel. They don't ship a calendar, a marketplace, or a course platform — those are apps. See [Kernel vs. apps](#kernel-vs-apps).

- **Attestation** — every trust-relevant act emits a signed, append-only record. Unsigned attestations are rejected at write.
- **Communication** — DID-based messaging, end-to-end encrypted, scoped by identity type.
- **Attribution (`.fair`)** — every asset carries a signed manifest of who contributed what, in what proportion.
- **Settlement** — transactions verify `.fair` signatures before money moves. No invoice, no human in the loop.
- **Discovery** — a federated registry, plus selective disclosure for what a node reveals to whom.
- **Revocation** — the option to leave: withdraw, tombstone, or hard-destroy. Propagation is part of the primitive, not an afterthought.

Full spec: [MJN Whitepaper](./docs/mjn-whitepaper.md).

### Proof of history, not proof of work

Crypto got proof of work wrong. Burning electricity to win a lottery isn't work — it's waste. Imajin's attestation model is **proof of history**: a signed, append-only record of real things that happened. The value isn't in the burning. It's in the record.

## What you can do today

- **Run a community.** Members, forums, governance, shared identity — self-hosted, not rented from Discord, Circle, or Mighty Networks.
- **Run events.** Sell tickets, accept e-Transfer or Stripe, send receipts, manage guest lists. [jin.imajin.ai/events](https://jin.imajin.ai/events)
- **Host an identity.** Cryptographic DID, attestations, contact channels.
- **Accept payments.** Stripe plus optional Solana, via Stripe Connect — the node operator is the merchant of record, not the platform.
- **Build on it.** Reuse auth, identity, payments, and attribution as primitives instead of stitching together five SaaS APIs. See [Build an app](#build-an-app).

## Kernel vs. apps

The kernel is the six primitives above plus the rails that serve them. Everything in `apps/*` other than `apps/kernel` is a third-party service that talks to the kernel through the registered-app contract ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981)) — these are **apps built on Imajin**, never Imajin's apps. Extraction into separate repos hasn't landed yet (Phase 0 of #1981 — the contract itself — is still in progress), so today they run inside this monorepo, but the boundary is meant to hold before the extraction lands, not after.

| App | What it does | Status | Docs |
|---|---|---|---|
| [broker-agent](./apps/broker-agent) | Telegram broker agent — conversational surface for broker-mediated social coordination | In development; not yet classified as kernel rail or app ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981)) | [README](./apps/broker-agent/README.md) |
| [coffee](./apps/coffee) | Tip jar / support page | Live | [README](./apps/coffee/README.md) |
| [corpus](./apps/corpus) | Per-DID corpus indexing and BM25 search — an internal daemon, not a subdomain web app | Live (internal); not yet classified as kernel rail or app ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981), [#1726](https://github.com/ima-jin/imajin-ai/issues/1726)) | [README](./apps/corpus/README.md) |
| [dykil](./apps/dykil) | Surveys & polls | Live | [README](./apps/dykil/README.md) |
| [events](./apps/events) | Create events, sell tickets, issue signed tickets | Live | [README](./apps/events/README.md) |
| [learn](./apps/learn) | Courses, lessons, learning progress | Live | [README](./apps/learn/README.md) |
| [links](./apps/links) | Curated link collection | Live | [README](./apps/links/README.md) |
| [market](./apps/market) | Marketplace: listings, trust-gated commerce | Live | [README](./apps/market/README.md) |

`apps/kernel` is the kernel service itself (the primitives above), not a third-party app — see its own [README](./apps/kernel/README.md).

## Build an app

An app registers as an identity with the kernel, gets scoped tokens, and never reaches into kernel internals — that's the registered-app contract ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981)). Start from [imajin-app-template](https://github.com/ima-jin/imajin-app-template): it ships the contract, CI gates, and agent rules a registered app needs.

SDK packages an app actually needs — see [Packages](#packages-sdk) for the rest:

- [`@imajin/auth-client`](./packages/auth-client) — "Sign in with Imajin": JWT session management and ready-made Next.js route handlers
- [`@imajin/auth`](./packages/auth) — signing, verification, and scoped app-token auth guards
- [`@imajin/config`](./packages/config) — CORS, service routing, session config
- [`@imajin/fair`](./packages/fair) — `.fair` attribution types and validator

None of these are published to npm yet — see [Packages](#packages-sdk) for publish status.

Apps building on this surface today: [imajin-karaoke](https://github.com/ima-jin/imajin-karaoke), [imajin-fixready](https://github.com/ima-jin/imajin-fixready), [imajin-scorecard](https://github.com/ima-jin/imajin-scorecard) — separate repos, own databases, consuming identity/attestation/settlement.

## Packages (SDK)

Generated from `packages/*/package.json`. **None are published to npm yet** — every package is `private: true`; publishing is tracked in [#1982](https://github.com/ima-jin/imajin-ai/issues/1982) / [#1581](https://github.com/ima-jin/imajin-ai/issues/1581) / [#1011](https://github.com/ima-jin/imajin-ai/issues/1011) / [#1992](https://github.com/ima-jin/imajin-ai/issues/1992). Depend on them via `workspace:*` inside this monorepo today.

| Package | What it does |
|---|---|
| [`@imajin/auth`](./packages/auth) | Ed25519 keypairs, DID + session/app-token auth guards, permission tiers |
| [`@imajin/auth-client`](./packages/auth-client) | "Sign in with Imajin" SDK — JWT sessions, ready-made Next.js route handlers |
| [`@imajin/bus`](./packages/bus) | Event bus: publish → reactor chain (attestation, mjn, settle, notify, emit, webhook) |
| [`@imajin/chat`](./packages/chat) | Chat UI components — orchestrator, message bubble, voice, media |
| [`@imajin/cid`](./packages/cid) | Deterministic CIDv1 (dag-cbor + SHA-256) content addressing |
| [`@imajin/config`](./packages/config) | Shared service config — CORS, routing, sessions, handle validation |
| [`@imajin/db`](./packages/db) | Shared Postgres handle (postgres-js + Drizzle ORM) |
| [`@imajin/dfos`](./packages/dfos) | [DFOS](https://protocol.dfos.com) protocol bridge — content publish, chain signer, relay |
| [`@imajin/email`](./packages/email) | Email sending (SendGrid), templates, QR generation |
| [`@imajin/emit`](./packages/emit) | Fire-and-forget system-event emission (audit/telemetry sink) |
| [`eslint-config-imajin`](./packages/eslint-config-imajin) | Shared ESLint flat config for the monorepo |
| [`@imajin/fair`](./packages/fair) | `.fair` attribution types, validator, builder, React components |
| [`@imajin/input`](./packages/input) | Input components — emoji, voice, GPS, file upload |
| [`@imajin/llm`](./packages/llm) | LLM inference abstraction — cost tracking, provider routing |
| [`@imajin/logger`](./packages/logger) | Structured logging (pino-backed) and request middleware |
| [`@imajin/media`](./packages/media) | Media browser & asset display components |
| [`@imajin/money`](./packages/money) | Currency-safe Money primitive, signed FX snapshots, ECB rate cache |
| [`@imajin/notify`](./packages/notify) | Cross-channel notification client (email/in-app/chat) |
| [`@imajin/onboard`](./packages/onboard) | Anonymous-to-soft-DID onboarding (`<OnboardGate>`) |
| [`@imajin/pay`](./packages/pay) | Unified payments — Stripe + Solana |
| [`@imajin/tokens`](./packages/tokens) | Design tokens (DTCG format, Style Dictionary v4) |
| [`@imajin/trust-graph`](./packages/trust-graph) | Trust graph queries — pod membership, trust distance/radius |
| [`@imajin/ui`](./packages/ui) | Shared UI — nav bar, identity management, app launcher, theming |
| [`@imajin/vault-core`](./packages/vault-core) | Vault entry models — sealing, delegation, integrity verification |

### Plugin surface (OpenClaw)

The connector layer that lets an OpenClaw/Claude Code agent act as a kernel-registered identity.

| Package | What it does |
|---|---|
| [`@imajin/nanoclaw-imajin-channel`](./packages/nanoclaw-imajin-channel) | NanoClaw channel adapter — bridges `jin.imajin.ai` chat to an agent's own DID |
| [`@imajin/openclaw-infer-passthrough`](./packages/openclaw-infer-passthrough) | Local OpenAI-compatible proxy — mints kernel app-tokens, forwards inference calls to the kernel |
| [`@imajin/openclaw-reflex-guard`](./packages/openclaw-reflex-guard) | OpenClaw post-turn instruction-check guard (sealed-term + fuzzy reflex) |
| [`@imajin/claw-envelope`](./packages/claw-envelope) | Harness-agnostic context-envelope generator, plus the agent identity bootstrap CLI |
| [`@imajin/claw-provisioner`](./packages/claw-provisioner) | Operator-executed runner that materializes an envelope and boots the deploy stack |
| [`@imajin/usage-emitter-claude-code`](./packages/usage-emitter-claude-code) | Reference `usage.incurred` emitter — tails a Claude Code session log, posts it to the kernel |

## Run a node

```bash
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai
bash scripts/setup-local.sh
pnpm --filter @imajin/kernel dev   # http://localhost:3000
```

`setup-local.sh` installs dependencies, creates the `imajin_dev` database, wires `.env.local` for every service, runs migrations, and disables the invite gate for local dev. Production registration is invite-only. Full guide: [docs/DEVELOPER.md](./docs/DEVELOPER.md). Deployment topology: [docs/ENVIRONMENTS.md](./docs/ENVIRONMENTS.md).

## Project Status

<!-- stats:start -->
| Metric | Value | Method |
|---|---|---|
| Codebase | 332,544 lines (`.ts`/`.tsx`) | `git ls-files '*.ts' '*.tsx' \| xargs cat \| wc -l` |
| Commits | 3,755 | `git rev-list --count HEAD` |
| Live since | February 2026 | `git log --reverse --format=%ad --date=short` (first commit) |
| Services | 9 apps, 30 shared packages | `ls apps`, `ls packages` |
<!-- stats:end -->
_As of commit `cc9ae36b` (2026-09-06). Regenerated at each replay of [#2028](https://github.com/ima-jin/imajin-ai/issues/2028)._

Identities and inference cost aren't hand-typed into this table. There's no public identity-count endpoint yet. For inference cost: every node exposes a public, unauthenticated `GET /usage/api/rollup/{did}/latest`, returning the most recent signed `usage.rollup` attestation — self-verifiable against the issuer's key ([#2030](https://github.com/ima-jin/imajin-ai/issues/2030)). Read the ledger; this README doesn't assert a dollar figure it can't sign.

## Docs, RFCs, spec

| Doc | What it covers |
|---|---|
| [MJN Whitepaper](./docs/mjn-whitepaper.md) | Full protocol spec — the six primitives, cryptographic stack, infrastructure layers |
| [Developer Guide](./docs/DEVELOPER.md) | Local setup, env vars, workflows |
| [Environments](./docs/ENVIRONMENTS.md) | Database & deployment topology |
| [Migrations](./docs/MIGRATIONS.md) | Database migration system |
| [RFC index](./docs/rfcs/INDEX.md) | All RFCs, including the conformance suite ([RFC-21](./docs/rfcs/RFC-21-imajin-conformance-suite.md), tracked in [#1287](https://github.com/ima-jin/imajin-ai/issues/1287)) |

This repository is the Imajin Inc. reference implementation of the MJN protocol, not the protocol spec itself — the method/spec work is scoped to move toward a separate protocol entity over time (the "two-entity" split referenced in [RFC-40](./docs/rfcs/RFC-40-did-imajin-resolution.md) §10 and the RFC-20/21 conformance framing). The RFC index is the canonical pointer as that split evolves.

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

Have at it. Careful what you wish for.

## License

[Imajin Network License (INL) v1.0](./LICENSE.md) — **not MIT.** Free to use, copy, modify, and sell for personal use, non-commercial use, small businesses, and 90-day evaluation. Organizations with over CAD $1,000,000 annual revenue doing commercial use must additionally run a Node Identity, produce `.fair` attribution manifests for what they process, and stay protocol-conformant — participation, not a fee. Read [LICENSE.md](./LICENSE.md) for the full terms.

---

*Built by [Imajin](https://imajin.ai) — 今人 (ima-jin) — "now-person" / "imagination"*
