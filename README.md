# Imajin
<!-- Kernel app-auth pod membership contract tracked in #2538. -->

**You compose. Imajin orchestrates. Signed. Legible.**

You bring your identity, choose your tools, and compose work with other people and agents. You keep authorship and control; with Imajin's signed, scoped rails you can connect, disclose selectively, and account for what happened — *the speed of thought, signed.*

## What it is

The kernel is **Attestation · Communication · Attribution · Settlement · Discovery · Revocation**, plus the rails that serve them: identity/auth, the bus, connectors, inference passthrough and media. Identity is the subject, not a seventh primitive.

**Proof of history, not proof of work:** signatures and linked records establish who asserted what, under whose authority.
They do not prove every underlying claim true; see the [proof model](docs/guide/proof-model.md) and [whitepaper](docs/mjn-whitepaper.md).

Revocation is the option to leave: withdraw → soft tombstone → hard destruction of hash/key while retaining the tombstone. The record remembers **that**, not **what**; propagation is part of the primitive ([canonical ruling](https://github.com/ima-jin/imajin-ai/issues/2027)), not a claim that every propagation use case is finished.

## What you can do today

**Replay dated 2026-10-16; repository and registry verification performed 2026-10-17 UTC.**

- Run the kernel locally, register an identity, and compose with its auth, profile, messaging, media and settlement surfaces. Start with the [developer guide](docs/guide/README.md); permissions, connector configuration and deployment state determine what is available.
- Build a registered app using published auth-client and SDK packages rather than kernel imports. See [Build an app](#build-an-app).
- Use apps built on Imajin from their own repositories: coffee, learn and market completed standalone **prod and dev** cutovers on 2026-10-16 ([coffee #2497](https://github.com/ima-jin/imajin-ai/issues/2497), [learn #2502](https://github.com/ima-jin/imajin-ai/issues/2502), [market #2510](https://github.com/ima-jin/imajin-ai/issues/2510)). Cutover is not a guarantee that all app flows are defect-free; their issue threads retain sign-in and settlement follow-ups.

**v0.8.21 has shipped as tagged source and npm SDK artifacts** ([tag](https://github.com/ima-jin/imajin-ai/tree/v0.8.21)); the [kernel production deploy](https://github.com/ima-jin/imajin-ai/actions/runs/38981978863) was still awaiting approval when checked on 2026-10-17 UTC. On 2026-10-16, work formerly grouped under v0.9.0 — the `/jin` console and reach chain — was hoisted onto the current train. That is a scheduling ruling, **not a claim those feature sets have shipped**; the [reach-chain tracker](https://github.com/ima-jin/imajin-ai/issues/2587) remains the status source.

## Kernel vs. apps

A node operator runs the kernel, not a calendar. Third-party services are **apps built on Imajin**, registered as identities and limited to the [registered-app contract](https://github.com/ima-jin/imajin-ai/issues/1981): scoped tokens, published SDK and public kernel APIs, not shared kernel internals.

Current `apps/*` inventory after #2517 (includes the kernel and internal services without pretending they are all third-party apps):

| Directory at HEAD | What it is | Boundary / status (2026-10-17) | Owned README |
|---|---|---|---|
| `apps/broker-agent` | Telegram conversational surface for broker-mediated coordination | In monorepo; rail/app classification remains undecided in #1981; not asserted production-ready | [README](apps/broker-agent/README.md) |
| `apps/corpus` | Per-DID indexing and BM25 search | In monorepo; internal daemon, not a public vertical; rail/app classification remains undecided | [README](apps/corpus/README.md) |
| `apps/kernel` | Attestation · Communication · Attribution · Settlement · Discovery · Revocation, plus supporting rails | The kernel itself, **not** a third-party app | [README](apps/kernel/README.md) |

Apps whose monorepo copies have already been pruned:

| App | What you compose | Location / status as of 2026-10-17 | Owned README |
|---|---|---|---|
| coffee | Tips and support | Standalone prod + dev; `apps/coffee` absent at HEAD | [coffee](https://github.com/ima-jin/coffee/blob/main/README.md) |
| events | Event pages, ticketing and check-in | Standalone prod + dev signed off; kernel copy pruned in #2517 | [events](https://github.com/ima-jin/events/blob/main/README.md) |
| learn | Courses and learning | Standalone prod + dev; `apps/learn` absent at HEAD | [learn](https://github.com/ima-jin/learn/blob/main/README.md) |
| market | Listings and purchases | Standalone prod + dev; `apps/market` absent at HEAD | [market](https://github.com/ima-jin/market/blob/main/README.md) |
| links | Link-in-bio pages | Own repository; monorepo copy pruned 2026-09-28 | [links](https://github.com/ima-jin/links/blob/main/README.md) |
| dykil | Surveys and signed responses | Own repository; monorepo copy pruned ([#2523](https://github.com/ima-jin/imajin-ai/issues/2523)); cutover/import acceptance **still in progress** ([#2522](https://github.com/ima-jin/imajin-ai/issues/2522)) | [dykil](https://github.com/ima-jin/dykil/blob/main/README.md) |

Events standalone dev was signed off on 2026-10-16 02:33Z and prod has run from `~/prod/events` since 2026-10-16 22:44Z ([#2517 status](https://github.com/ima-jin/imajin-ai/issues/2517#issuecomment-6228145370)). Ports **3006/7006** and the Caddy **`/events` prefix** are unchanged; app setup and deployment belong to [ima-jin/events](https://github.com/ima-jin/events).

Under the 2026-10-09 [prune-on-dev ruling](https://github.com/ima-jin/imajin-ai/issues/1981#issuecomment-6083425361), app source is pruned once standalone dev holds; pruning does not prove prod acceptance and does not drop app schema/data.

**Deploy guard:** this pruned kernel reaches prod only in a release cut after **#2516 step 8 (events buy/refund) passes**. Until then **`~/prod/imajin-ai/apps/events` stays on disk as the rollback path**; **Ryan's tap 2 gates the prod deploy**. Merging this source prune is not deployment approval.

## Build an app

Start from the [app template's owned README](https://github.com/ima-jin/imajin-app-template/blob/main/README.md), preserving template history. Follow the [registration contract](docs/REGISTRATION.md) and the template's own setup, schema ownership and claim instructions.

For sign-in and session handlers, use [`@ima-jin/auth-client`](packages/auth-client/README.md). Add published [`auth`](packages/auth/package.json), [`config`](packages/config/package.json), [`logger`](packages/logger/package.json), [`ui`](packages/ui/package.json) or [`fair`](packages/fair/package.json) only where your app needs them.

```bash
npm install @ima-jin/auth-client@0.8.21
```

External apps install **`@ima-jin/*` from npmjs.org anonymously**; in-repo imports remain **`@imajin/*`**. The publish pipeline rewrites the scope and strips `private: true` in the publish copy; the workspace flag is not evidence of publication. See [publishing mechanics](docs/npm-publishing.md). Never use workspace-only packages as an out-of-repo install instruction or access another service's database.

## Packages (SDK)

Generated from every `packages/*/package.json` at `ddc114bbd028a1efa5852569e36d0569343c8739`. Descriptions use manifest text where supplied (long plugin descriptions shortened); manifests without descriptions use their public exports. Publish status was checked anonymously on **2026-10-17 UTC** with `npm view <published-name> version --registry=https://registry.npmjs.org --userconfig=/dev/null`: **12 published, 18 workspace-only**. Registry links expose the live `latest` record; the version shown is the checked snapshot, not a promise about future releases.

### Core SDK and workspace libraries

| Workspace package | What it provides | Publish status |
|---|---|---|
| [`@imajin/auth`](packages/auth/package.json) | Authentication, scoped authorization, DID helpers, signing and verification | [`@ima-jin/auth@0.8.21`](https://registry.npmjs.org/@ima-jin/auth/latest) |
| [`@imajin/auth-client`](packages/auth-client/package.json) | "Sign in with Imajin" SDK for federated apps — JWT session management and ready-made Next.js route handlers | [`@ima-jin/auth-client@0.8.21`](https://registry.npmjs.org/@ima-jin/auth-client/latest) |
| [`@imajin/bus`](packages/bus/package.json) | Event publishing, consent brokering and ordered reactor chains | Workspace-only; npm 404 |
| [`@imajin/chat`](packages/chat/package.json) | Chat components, message rendering and real-time hooks | Workspace-only; npm 404 |
| [`@imajin/cid`](packages/cid/package.json) | Deterministic CIDv1 (dag-cbor + SHA-256) helpers shared across Imajin services | [`@ima-jin/cid@0.8.21`](https://registry.npmjs.org/@ima-jin/cid/latest) |
| [`@imajin/config`](packages/config/package.json) | Shared configuration for Imajin services — CORS, service routing, session config, handle validation, and route helpers | [`@ima-jin/config@0.8.21`](https://registry.npmjs.org/@ima-jin/config/latest) |
| [`@imajin/db`](packages/db/package.json) | Drizzle/postgres database handle shared across Imajin services | [`@ima-jin/db@0.8.21`](https://registry.npmjs.org/@ima-jin/db/latest) |
| [`@imajin/dfos`](packages/dfos/package.json) | DFOS identity-chain verification and content publishing | Workspace-only; npm 404 |
| [`@imajin/email`](packages/email/package.json) | Email delivery, templates and QR generation | Workspace-only; npm 404 |
| [`@imajin/emit`](packages/emit/package.json) | Service-scoped operational event emission | Workspace-only; npm 404 |
| [`eslint-config-imajin`](packages/eslint-config-imajin/package.json) | Shared ESLint flat config for imajin-ai monorepo | Workspace-only; npm 404 |
| [`@imajin/fair`](packages/fair/package.json) | Shared .fair attribution types, validator, builder, and React components | [`@ima-jin/fair@0.8.21`](https://registry.npmjs.org/@ima-jin/fair/latest) |
| [`@imajin/input`](packages/input/package.json) | Composable text, voice, location and attachment inputs | Workspace-only; npm 404 |
| [`@imajin/llm`](packages/llm/package.json) | Vercel AI SDK provider factory and usage-cost calculation | Workspace-only; npm 404 |
| [`@imajin/logger`](packages/logger/package.json) | Structured logging and request middleware | [`@ima-jin/logger@0.8.21`](https://registry.npmjs.org/@ima-jin/logger/latest) |
| [`@imajin/media`](packages/media/package.json) | Media browser, asset display components, and resolveMediaRef/resolveAssetUrl helpers for Imajin apps | [`@ima-jin/media@0.8.21`](https://registry.npmjs.org/@ima-jin/media/latest) |
| [`@imajin/money`](packages/money/package.json) | Currency-safe Money primitive, signed FX snapshots, and ECB rate cache-through (#1950) | Workspace-only; npm 404 |
| [`@imajin/notify`](packages/notify/package.json) | Credential-provider-backed notification and broadcast client | Workspace-only; npm 404 |
| [`@imajin/onboard`](packages/onboard/package.json) | OnboardGate — React component that gates a page behind Imajin onboarding (handle/identity setup) | [`@ima-jin/onboard@0.8.21`](https://registry.npmjs.org/@ima-jin/onboard/latest) |
| [`@imajin/provision-bootstrap`](packages/provision-bootstrap/package.json) | Build-time ESM compilation for the service-bootstrap entrypoint | Workspace-only; npm 404 |
| [`@imajin/tokens`](packages/tokens/package.json) | Imajin design tokens — DTCG format, built with Style Dictionary v4 | [`@ima-jin/tokens@0.8.21`](https://registry.npmjs.org/@ima-jin/tokens/latest) |
| [`@imajin/trust-graph`](packages/trust-graph/package.json) | Pod membership traversal and trust-graph queries | Workspace-only; npm 404 |
| [`@imajin/ui`](packages/ui/package.json) | Shared UI components for Imajin apps — NavBar, identity management, app launcher, theming, and common patterns | [`@ima-jin/ui@0.8.21`](https://registry.npmjs.org/@ima-jin/ui/latest) |
| [`@imajin/vault-core`](packages/vault-core/package.json) | Vault entry models, integrity verification, sealing and delegation primitives for Imajin nodes | [`@ima-jin/vault-core@0.8.21`](https://registry.npmjs.org/@ima-jin/vault-core/latest) |

### Plugin and harness surface

The [OpenClaw Imajin plugin](https://github.com/ima-jin/openclaw-imajin-plugin/blob/main/README.md) lives in its own repository, outside this manifest inventory. Channel, inference passthrough, reflex guard, envelope, provisioner and usage-emitter packages below are workspace-only; no npm installation is claimed for them.

| Workspace package | What it provides | Publish status |
|---|---|---|
| [`@imajin/claw-envelope`](packages/claw-envelope/package.json) | Harness-agnostic RFC-31 context envelopes and agent identity bootstrap | Workspace-only; npm 404 |
| [`@imajin/claw-provisioner`](packages/claw-provisioner/package.json) | Operator-executed envelope materialization and hosted-runner provisioning | Workspace-only; npm 404 |
| [`@imajin/nanoclaw-imajin-channel`](packages/nanoclaw-imajin-channel/package.json) | NanoClaw chat channel, MCP token refresh and usage-emitter sidecars | Workspace-only; npm 404 |
| [`@imajin/openclaw-infer-passthrough`](packages/openclaw-infer-passthrough/package.json) | Local OpenAI-compatible proxy to kernel inference with direct fallback | Workspace-only; npm 404 |
| [`@imajin/openclaw-reflex-guard`](packages/openclaw-reflex-guard/package.json) | OpenClaw post-turn sealed-term guard and fuzzy-reflex scaffold | Workspace-only; npm 404 |
| [`@imajin/usage-emitter-claude-code`](packages/usage-emitter-claude-code/package.json) | Claude Code session usage emitter to the kernel usage API | Workspace-only; npm 404 |

## Run a node

For a local kernel: **Node.js 22+, pnpm 9, PostgreSQL 14+** and its client tools. The [setup helper](scripts/setup-local.sh) installs workspace dependencies, prepares local kernel env files, migrates the local database and provisions service bootstrap identities. It does **not** set up or require starting standalone events or another vertical.

```bash
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai
bash scripts/setup-local.sh
pnpm --filter @imajin/kernel dev
```

Open `http://localhost:3000/register` locally and save your key file. The helper disables the invite gate **for local development only**; production registration remains policy-gated. Only the kernel is started by the command above — not `pnpm dev`, which starts the workspace.

Setup details: [local development](docs/DEVELOPER.md). Production deployment: [operations/environment reference](docs/ENVIRONMENTS.md) and [deploy configuration](deploy/README.md); use the reviewed release/deploy workflows, not a manual production `git pull`. Extracted apps use their own deployment docs.

## Project status

<!-- stats:start -->
Historical snapshot generated 2026-10-17 UTC from source commit [`ddc114bb`](https://github.com/ima-jin/imajin-ai/commit/ddc114bbd028a1efa5852569e36d0569343c8739) for the 2026-10-16 replay, before the #2517 events prune. The app count below includes that former copy; the current inventory above does not.

| Repository metric | Computed value |
|---|---|
| Reachable commits (`git rev-list --count HEAD`, full history) | 5126 |
| `apps/*/package.json` | 4 (includes kernel and internal services) |
| `packages/*/package.json` | 30 |
<!-- stats:end -->

No live identity count or unsigned inference-cost estimate is asserted here. Signed usage records are described by the [usage-rollup read model](apps/kernel/app/usage/api/rollup/[did]/latest/route.ts).

## Docs / RFCs / spec

- [Developer guide index](docs/guide/README.md) · [HTTP walkthrough](docs/developer-guide.md) · [environment reference](docs/ENVIRONMENTS.md) · [migrations](docs/MIGRATIONS.md).
- [Whitepaper](docs/mjn-whitepaper.md) · [RFC index](docs/rfcs/INDEX.md) · [API spec source](apps/kernel/app/jin/api/spec/route.ts).
- [Conformance tracker #1287](https://github.com/ima-jin/imajin-ai/issues/1287): the assembled node suite remains tracked work, not a certification asserted by this README.
- The two-entity architecture (Canadian reference-build company / proposed Swiss protocol steward) remains a [memo and conformance dependency in #1287](https://github.com/ima-jin/imajin-ai/issues/1287), not a claim that the proposed entity exists.
- [Build log](apps/kernel/content/build-log.md) · [generated process log](apps/kernel/content/process-log.md). Historical entries retain their dates; they are not current deployment claims.

Linked docs can lag the implementation; the read-only drift inventory for this replay is recorded on [#2028](https://github.com/ima-jin/imajin-ai/issues/2028). This replay changes only the root README.

## Contributing

Read [AGENTS.md](AGENTS.md), the [canonical patterns](docs/guide/canonical-patterns.md) and the [PR checklist](docs/PR-CHECKLIST.md). Use an isolated worktree and a PR; respect service boundaries. Repository checks: `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`. Release workflows alone bump manifest versions.

## Security

See [SECURITY.md](SECURITY.md) for responsible disclosure and known limitations. User signatures, node assertions and operational logs are different guarantees; consult the [proof model](docs/guide/proof-model.md), not the hero, when deciding what a verifier can establish.

## A note on use

You can use a general-purpose tool well or badly. The commitment here is legibility, not a promise to make misuse impossible: authority, disclosure and signed actions should leave an inspectable record, including our own. A signature proves who asserted a claim, not that the claim is true; soft-DID activity and unsigned operational logs are not user signatures.

The [honest-record accountability issue #1427](https://github.com/ima-jin/imajin-ai/issues/1427) closed on 2026-09-23 after the resolver and durable audit-log gaps shipped. That closes those tracked gaps, not every security or revocation-propagation use case. Check the implementation, [known limitations](SECURITY.md), and [license](LICENSE.md).

## License

[Imajin Network License (INL) v1.0](LICENSE.md), **not MIT**. Source-available, with notice requirements for everyone and network-participation conditions for covered commercial organizations above the CAD $1 million annual-revenue threshold. Read the license for the actual conditions and exemptions; this summary does not replace it.
