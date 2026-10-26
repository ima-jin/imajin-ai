# Imajin
<!-- Docs delta replay started 2026-10-26 for v0.8.28; Refs #2028. -->
<!-- Wide documentation replay: 2026-10-25, source 4d7b2dc1aa3a1dc721a35c863b47d283ae5c67bf, v0.8.26..main (#2028). -->

**You compose. Imajin orchestrates. Signed. Legible.**

You choose your tools, bring your identity, and compose work with people and agents.
Connect a service, authorize an app, or inspect a signed record without becoming
the object being managed — *the speed of thought, signed.*

## What it is

Imajin is **Agentic Relation Management**: the relation is at the center, with
agents on both sides. Its kernel serves **Attestation · Communication · Attribution ·
Settlement · Discovery · Revocation**, plus identity/auth, the bus, connectors,
inference passthrough and media. Identity is their subject, not a seventh primitive.

**Proof of history, not proof of work:** signatures and linked records establish
who asserted what, under whose authority, not that every assertion is true.
See the [proof model](docs/guide/proof-model.md) and [whitepaper](docs/mjn-whitepaper.md).

Revocation is the option to leave: withdraw → soft tombstone → hard destruction of
hash/key, keeping the tombstone. The record remembers **that**, not **what**.
[Propagation is part of its canonical shape](https://github.com/ima-jin/imajin-ai/issues/2027),
not a guarantee that every concrete use case is implemented.

## What you can do today

**Source checked 2026-10-25 UTC against v0.8.26..`4d7b2dc1a`; v0.8.27 is pre-cut, not released.**

- Run a kernel, register an identity and compose auth, profile, messaging and media
  surfaces. The [guide index](docs/guide/README.md) explains permissions and setup.
- Connect your agent through the [OpenClaw plugin](https://github.com/ima-jin/openclaw-imajin-plugin/blob/main/README.md),
  or build a registered app with the published SDK below.
- Inspect Registered apps, Clear consent with confirmation and retain revoked/expired
  history. Use personal or authorized organization Record and actionable-only
  Inbox/Operator views. [Kernel-owned details and citations](apps/kernel/README.md).
- Use principal-based inference minting and the usable model catalog. Re-grant after
  revoked/expired consent; the [release updater](deploy/infer-passthrough/README.md)
  requires exact-SHA production evidence and mint-backed health before promotion.
- Maintain per-field legal-entity release or sealed bank-details records through
  the API. Human-session/auth-scoped ownership and Tier 0 custody limits apply;
  bank settings UI and invoice disclosure are not claimed. [Developer contracts](docs/DEVELOPER.md#sealed-bank-details-api-3075).
- Issue purpose-scoped SSH user certificates and reuse the
  [GitHub OIDC deploy action](docs/deploy/vault-ssh-deploy.md). Live grants, TTL,
  pinned host keys, host trust/principals and non-swappable tmpfs are explicit
  requirements, not proof that a host rollout happened.
- Index GitHub sources under their registry-resolved owner DID with that owner's
  OAuth connector. Live corpus grants and explicit connector selection are
  required, with no node-token fallback. [Corpus runbook](apps/corpus/README.md).
- Discover your own live exact-zone Cloudflare grants as metadata, never credential
  values. Acting identities cannot widen the list. [Domain guide](docs/guide/domain-ownership.md#domain-scoped-credentials).

The [v0.8.26 source tag](https://github.com/ima-jin/imajin-ai/tree/v0.8.26)
and public SDK artifacts are available. The [production workflow](https://github.com/ima-jin/imajin-ai/actions/runs/39777022949)
succeeded on 2026-10-22 for `c75e4fd195ef125f82c986ba1313bb8365f408f3`;
that is not evidence of deployment of later main or acceptance of every app flow.

## Kernel vs. apps

A node operator runs the kernel, not a calendar. Third-party services are **apps
built on Imajin**: identities using scoped tokens, published SDKs and public APIs
under the [registered-app contract](https://github.com/ima-jin/imajin-ai/issues/1981),
not kernel internals or another service's database.

Generated from every `apps/*/package.json` at the source snapshot:

| Directory | What it provides | Boundary | Owned README |
|---|---|---|---|
| `apps/broker-agent` | Telegram broker agent — conversational surface for broker-mediated social coordination | Internal agent surface; rail/app classification remains undecided in #1981 | [README](apps/broker-agent/README.md) |
| `apps/corpus` | Per-DID corpus indexing and BM25 search service | Internal owner-DID retrieval daemon; rail/app classification remains undecided in #1981 | [README](apps/corpus/README.md) |
| `apps/kernel` | Six primitives and their supporting rails | The kernel, not a third-party app | [README](apps/kernel/README.md) |

The extracted verticals have owned repositories; none is a workspace target here.
Earlier cutover records are dated, not inferred from source removal:

| App | What you compose | Recorded status | Owned README |
|---|---|---|---|
| coffee | Tips and support | Prod/dev cutover recorded 2026-10-16 in [#2497](https://github.com/ima-jin/imajin-ai/issues/2497) | [coffee](https://github.com/ima-jin/coffee/blob/main/README.md) |
| dykil | Surveys and responses | Standalone services serving; 2026-10-20 dev import failed signature checks and no prod import ran ([#2522](https://github.com/ima-jin/imajin-ai/issues/2522)) | [dykil](https://github.com/ima-jin/dykil/blob/main/README.md) |
| events | Event pages, ticketing, check-in | [#2516](https://github.com/ima-jin/imajin-ai/issues/2516) closed 2026-10-20; future buy/QR smoke is [#2989](https://github.com/ima-jin/imajin-ai/issues/2989), registry controls [#2988](https://github.com/ima-jin/imajin-ai/issues/2988) | [events](https://github.com/ima-jin/events/blob/main/README.md) |
| learn | Courses and learning | Prod/dev cutover recorded 2026-10-16 in [#2502](https://github.com/ima-jin/imajin-ai/issues/2502) | [learn](https://github.com/ima-jin/learn/blob/main/README.md) |
| links | Link-in-bio pages | Own repository; kernel copy pruned 2026-09-28 | [links](https://github.com/ima-jin/links/blob/main/README.md) |
| market | Listings and purchases | Prod/dev cutover recorded 2026-10-16 in [#2510](https://github.com/ima-jin/imajin-ai/issues/2510) | [market](https://github.com/ima-jin/market/blob/main/README.md) |

The [prune-on-dev ruling](https://github.com/ima-jin/imajin-ai/issues/1981#issuecomment-6083425361)
separates source removal from prod acceptance; pruning never drops app schema/data.
Events' [2026-10-20 ruling](https://github.com/ima-jin/imajin-ai/issues/2516#issuecomment-6294184437)
retired the kernel-copy rollback. Use its owned prior deployment ref.

## Build an app

Start from the [app template's owned README](https://github.com/ima-jin/imajin-app-template/blob/main/README.md),
preserving its history; follow the [registration contract](docs/REGISTRATION.md).
Use [auth-client](packages/auth-client/README.md) for sign-in/session handlers;
add published auth/config/logger/ui/fair only as needed.

```bash
npm install @ima-jin/auth-client@0.8.26
```

External consumers install **`@ima-jin/*`** anonymously from npmjs.org; workspace
imports use **`@imajin/*`**. The [publish pipeline](docs/npm-publishing.md) rewrites
scope and removes `private: true` in the publish copy. That flag is not publication
evidence. Do not install workspace-only internals.

## Packages (SDK)

Generated from every `packages/*/package.json` at
[`4d7b2dc1a`](https://github.com/ima-jin/imajin-ai/tree/4d7b2dc1aa3a1dc721a35c863b47d283ae5c67bf).
Descriptions use manifests, or checked current exports when absent. Anonymous
registry `latest` checks on 2026-10-25 UTC: **12 published, 18
workspace-only**. Registry links show live metadata; versions are a checked snapshot.
Tracking: [#1982](https://github.com/ima-jin/imajin-ai/issues/1982),
[#1581](https://github.com/ima-jin/imajin-ai/issues/1581),
[#1011](https://github.com/ima-jin/imajin-ai/issues/1011),
[#1992](https://github.com/ima-jin/imajin-ai/issues/1992).

### Core SDK and workspace libraries

| Workspace package | What it provides | Publish status |
|---|---|---|
| [`@imajin/auth`](packages/auth/package.json) | Authentication, scoped authorization, DID helpers, signing and verification | [`@ima-jin/auth@0.8.26`](https://registry.npmjs.org/@ima-jin/auth/latest) |
| [`@imajin/auth-client`](packages/auth-client/package.json) | "Sign in with Imajin" SDK for federated apps — JWT session management and ready-made Next.js route handlers | [`@ima-jin/auth-client@0.8.26`](https://registry.npmjs.org/@ima-jin/auth-client/latest) |
| [`@imajin/bus`](packages/bus/package.json) | Event publishing, consent brokering and ordered reactor chains | Workspace-only; npm 404 |
| [`@imajin/chat`](packages/chat/package.json) | Chat components, message rendering and real-time hooks | Workspace-only; npm 404 |
| [`@imajin/cid`](packages/cid/package.json) | Deterministic CIDv1 (dag-cbor + SHA-256) helpers shared across Imajin services | [`@ima-jin/cid@0.8.26`](https://registry.npmjs.org/@ima-jin/cid/latest) |
| [`@imajin/config`](packages/config/package.json) | Shared configuration for Imajin services — CORS, service routing, session config, handle validation, and route helpers | [`@ima-jin/config@0.8.26`](https://registry.npmjs.org/@ima-jin/config/latest) |
| [`@imajin/db`](packages/db/package.json) | Drizzle/postgres database handle shared across Imajin services | [`@ima-jin/db@0.8.26`](https://registry.npmjs.org/@ima-jin/db/latest) |
| [`@imajin/dfos`](packages/dfos/package.json) | DFOS identity-chain verification and content publishing | Workspace-only; npm 404 |
| [`@imajin/email`](packages/email/package.json) | Email delivery, templates and QR generation | Workspace-only; npm 404 |
| [`@imajin/emit`](packages/emit/package.json) | Service-scoped operational event emission | Workspace-only; npm 404 |
| [`eslint-config-imajin`](packages/eslint-config-imajin/package.json) | Shared ESLint flat config for imajin-ai monorepo | Workspace-only; npm 404 |
| [`@imajin/fair`](packages/fair/package.json) | Shared .fair attribution types, validator, builder, and React components | [`@ima-jin/fair@0.8.26`](https://registry.npmjs.org/@ima-jin/fair/latest) |
| [`@imajin/input`](packages/input/package.json) | Composable text, voice, location and attachment inputs | Workspace-only; npm 404 |
| [`@imajin/llm`](packages/llm/package.json) | AI SDK 5 provider factory, Zod 4 tool contracts and usage-cost calculation | Workspace-only; npm 404 |
| [`@imajin/logger`](packages/logger/package.json) | Structured logging and request middleware | [`@ima-jin/logger@0.8.26`](https://registry.npmjs.org/@ima-jin/logger/latest) |
| [`@imajin/media`](packages/media/package.json) | Media browser, asset display components, and resolveMediaRef/resolveAssetUrl helpers for Imajin apps | [`@ima-jin/media@0.8.26`](https://registry.npmjs.org/@ima-jin/media/latest) |
| [`@imajin/money`](packages/money/package.json) | Currency-safe Money primitive, signed FX snapshots, and ECB rate cache-through (#1950) | Workspace-only; npm 404 |
| [`@imajin/notify`](packages/notify/package.json) | Credential-provider-backed notification and broadcast client | Workspace-only; npm 404 |
| [`@imajin/onboard`](packages/onboard/package.json) | OnboardGate — React component that gates a page behind Imajin onboarding (handle/identity setup) | [`@ima-jin/onboard@0.8.26`](https://registry.npmjs.org/@ima-jin/onboard/latest) |
| [`@imajin/provision-bootstrap`](packages/provision-bootstrap/package.json) | Build-time ESM compile of scripts/lib/provision-service-bootstrap.ts (+ the kernel sources it imports) for scripts/provision-service-bootstrap.mjs (#2485) | Workspace-only; npm 404 |
| [`@imajin/tokens`](packages/tokens/package.json) | Imajin design tokens — DTCG format, built with Style Dictionary v4 | [`@ima-jin/tokens@0.8.26`](https://registry.npmjs.org/@ima-jin/tokens/latest) |
| [`@imajin/trust-graph`](packages/trust-graph/package.json) | Pod membership traversal and trust-graph queries | Workspace-only; npm 404 |
| [`@imajin/ui`](packages/ui/package.json) | Shared UI components for Imajin apps — NavBar, identity management, app launcher, theming, and common patterns | [`@ima-jin/ui@0.8.26`](https://registry.npmjs.org/@ima-jin/ui/latest) |
| [`@imajin/vault-core`](packages/vault-core/package.json) | Vault entry models, integrity verification, sealing and delegation primitives for Imajin nodes | [`@ima-jin/vault-core@0.8.26`](https://registry.npmjs.org/@ima-jin/vault-core/latest) |

### Plugin and harness surface

The external OpenClaw plugin and workspace channel, inference passthrough, reflex
guard, envelope, provisioner and usage-emitter packages are a distinct group.
No npm installation is claimed for workspace-only packages.

| Workspace package | What it provides | Publish status |
|---|---|---|
| [`@imajin/claw-envelope`](packages/claw-envelope/package.json) | Harness-agnostic RFC-31 context-envelope generator (imajin-ai#1932/#1933): agent DID + owner DID + intent in, workspace files/config/delegation-grant refs/bus routes out — plus a NanoClaw renderer and the agent identity bootstrap CLI. | Workspace-only; npm 404 |
| [`@imajin/claw-provisioner`](packages/claw-provisioner/package.json) | Operator-executed runner for the envelope provisioner (imajin-ai#1933): consumes a kernel provision record, materializes its rendered envelope, and (for hosted placements, non-dry-run only) runs the deploy/nanoclaw compose stack, reporting boot status back to the kernel. Never touches live infra by itself in this repo's tests/CI. | Workspace-only; npm 404 |
| [`@imajin/nanoclaw-imajin-channel`](packages/nanoclaw-imajin-channel/package.json) | Imajin chat bridge for a NanoClaw instance (imajin-ai#1932): a NanoClaw ChannelAdapter reachable at its own agent DID via the existing jin.imajin.ai chat channel, plus the MCP token-refresh proxy and usage.incurred emitter sidecars it depends on. | Workspace-only; npm 404 |
| [`@imajin/openclaw-infer-passthrough`](packages/openclaw-infer-passthrough/package.json) | Local OpenAI-compatible HTTP proxy (imajin-ai#1926, Phase 4 of the #1922 inference connectors epic): mints kernel app-token JWTs on OpenClaw's behalf and forwards custom-provider completions calls to POST /infer/v1/chat/completions, with break-glass direct fallback on kernel 5xx/timeout. | Workspace-only; npm 404 |
| [`@imajin/openclaw-reflex-guard`](packages/openclaw-reflex-guard/package.json) | OpenClaw plugin: post-turn instruction-check guard (imajin-ai#1252) — deterministic outbound sealed-term guard (Layer 1) + fuzzy reflex scaffold (Layer 2) | Workspace-only; npm 404 |
| [`@imajin/usage-emitter-claude-code`](packages/usage-emitter-claude-code/package.json) | Reference external usage.incurred emitter (#1151): tails Claude Code session JSONL and posts to POST /usage/api/incurred. | Workspace-only; npm 404 |

## Run a node

For the kernel only: Node.js 22+, pnpm 9, PostgreSQL 14+ and client tools.
The [setup helper](scripts/setup-local.sh) installs dependencies, prepares local
environment/migrations and provisions bootstrap identities, not extracted apps.

```bash
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai
bash scripts/setup-local.sh
pnpm --filter @imajin/kernel dev
```

Open `http://localhost:3000/register` and save your key file. The helper disables
the invite gate for local dev only; production remains policy-gated.
[Development](docs/DEVELOPER.md) · [deployment](deploy/README.md) ·
[environments](docs/ENVIRONMENTS.md). Production uses reviewed approval-gated
workflows, not a manual `git pull`; apps follow their own runbooks.

## Project status

<!-- stats:start -->
Generated 2026-10-25 UTC from source commit
[`4d7b2dc1a`](https://github.com/ima-jin/imajin-ai/commit/4d7b2dc1aa3a1dc721a35c863b47d283ae5c67bf);
full-history snapshot, not live deployment metrics.

| Repository metric | Computed value |
|---|---|
| Reachable commits (`git rev-list --count 4d7b2dc1a`) | 6048 |
| `apps/*/package.json` | 3 (includes kernel/internal services) |
| `packages/*/package.json` | 30 |
<!-- stats:end -->

No live identity count or unsigned inference-cost estimate is asserted. See the
[signed per-DID usage rollup](apps/kernel/app/usage/api/rollup/[did]/latest/route.ts),
not a guessed network total.

## Docs / RFCs / spec

- [Guide index](docs/guide/README.md) · [proof model](docs/guide/proof-model.md) ·
  [migrations](docs/MIGRATIONS.md) · [whitepaper](docs/mjn-whitepaper.md).
- [RFC index](docs/rfcs/INDEX.md) · [operator spec source](apps/kernel/app/jin/api/spec/route.ts) ·
  [complete route index](apps/kernel/public/llms.txt) ·
  [service contract reference](apps/kernel/public/llms-full.txt).
- [Conformance #1287](https://github.com/ima-jin/imajin-ai/issues/1287) tracks the
  assembled suite. This is not certification. The Canadian reference-build /
  proposed Swiss protocol-steward split remains a memo/dependency, not a claim
  that the proposed entity exists.
- [Build log](apps/kernel/content/build-log.md) and [process log](apps/kernel/content/process-log.md)
  retain dated history. [#2028](https://github.com/ima-jin/imajin-ai/issues/2028)
  holds the replay brief/run-logs; this wide pass checks all tracked text against
  the release diff and builds on #3108.

## Contributing

Read [AGENTS.md](AGENTS.md), [canonical patterns](docs/guide/canonical-patterns.md)
and the [PR checklist](docs/PR-CHECKLIST.md). Work in an isolated worktree.
Use `pnpm lint:agent`, `pnpm typecheck:agent`, `pnpm test:agent`, `pnpm build:agent`;
while iterating, run affected tests only. Release workflows alone bump versions.

## Security

Read [SECURITY.md](SECURITY.md) for disclosure and limitations. User signatures,
node assertions and operational logs have distinct guarantees. Consult the
proof model, not the hero, for what a verifier can establish.

## A note on use

A general-purpose tool can be used well or badly. The commitment is legibility,
not a promise to make misuse impossible: authority, disclosure and signed actions
should leave an inspectable record, including our own. A signature establishes who
asserted a claim, not its truth. Soft-DID activity and unsigned logs are not user signatures.

The [honest-record accountability issue #1427](https://github.com/ima-jin/imajin-ai/issues/1427)
closed 2026-09-23 after the resolver and durable-audit gaps shipped
([#1454](https://github.com/ima-jin/imajin-ai/pull/1454),
[#1500](https://github.com/ima-jin/imajin-ai/pull/1500)). Those closures do not
establish every security or revocation-propagation use case.

## License

[Imajin Network License (INL) v1.0](LICENSE.md), **not MIT**. Source-available, with
notice requirements and network-participation conditions for covered commercial
organizations above CAD $1 million annual revenue. The license defines conditions
and exemptions; this summary does not replace it.
