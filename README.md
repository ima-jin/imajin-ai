# Imajin
<!-- #2028 delta replay started 2026-10-22; source reconciliation in progress. -->

**You compose. Imajin orchestrates. Signed. Legible.**

You choose your tools, bring your identity, and compose work with people and agents. Connect a service, authorize an app, or inspect a signed record without making yourself the object being managed — *the speed of thought, signed.*

## What it is

Imajin is **Agentic Relation Management**: the relation is at the center, with agents on both sides. Its kernel is **Attestation · Communication · Attribution · Settlement · Discovery · Revocation**, plus identity/auth, the bus, connectors, inference passthrough and media. Identity is the subject the six act on, not a seventh primitive.

**Proof of history, not proof of work:** signatures and linked records establish who asserted what, under whose authority.
They do not establish that every claim is true; see the [proof model](docs/guide/proof-model.md) and [whitepaper](docs/mjn-whitepaper.md).

Revocation is the option to leave: withdraw → soft tombstone → hard destruction of hash/key, retaining the tombstone. The record remembers **that**, not **what**. Propagation is part of the [primitive's canonical shape](https://github.com/ima-jin/imajin-ai/issues/2027), not a guarantee that every use case is implemented.

## What you can do today

**Repository, registry and issue evidence checked 2026-10-21 UTC.**

- Run a local kernel, register an identity, and use its auth, profile, messaging and media surfaces. Start with the [developer guide index](docs/guide/README.md); configuration, permissions and deployment determine availability.
- Connect an agent through the [OpenClaw plugin](https://github.com/ima-jin/openclaw-imajin-plugin/blob/main/README.md), or compose a registered app with the published SDK. See [Build an app](#build-an-app).
- Choose apps built on Imajin from their owned repositories below. App deployment and acceptance are separate from a kernel release.

The [v0.8.25 source tag](https://github.com/ima-jin/imajin-ai/tree/v0.8.25) and npm SDK artifacts are available. The [kernel production workflow](https://github.com/ima-jin/imajin-ai/actions/runs/39439563638) succeeded on 2026-10-20 for `c8e84b354b7330c9f5d40c403147ded3143c17c0`; that does not certify later main commits or every app flow. This replay is **pre-cut upkeep for v0.8.26**, not an assertion that v0.8.26 is released.

## Kernel vs. apps

A node operator runs the kernel, not a calendar. Third-party services are **apps built on Imajin**: registered identities using scoped tokens, published SDKs and public APIs under the [registered-app contract](https://github.com/ima-jin/imajin-ai/issues/1981), never shared kernel internals.

Generated `apps/*` inventory at the source snapshot below; the kernel and internal services are explicitly distinguished from third-party apps:

| Directory | What it provides | Boundary | Owned README |
|---|---|---|---|
| `apps/broker-agent` | Telegram broker agent — conversational surface for broker-mediated social coordination | In-repo agent surface; rail/app classification undecided in #1981; no production-readiness claim | [README](apps/broker-agent/README.md) |
| `apps/corpus` | Per-DID corpus indexing and BM25 search service | Internal daemon; rail/app classification undecided in #1981 | [README](apps/corpus/README.md) |
| `apps/kernel` | Six primitives and their supporting rails | The kernel, not a third-party app | [README](apps/kernel/README.md) |

The extracted verticals live in their own repositories; none is an `apps/*` workspace target here. Status is dated 2026-10-21, not inferred from missing source:

| App | What you compose | Recorded status | Owned README |
|---|---|---|---|
| coffee | Tips and support | Standalone prod + dev; cutover recorded in [#2497](https://github.com/ima-jin/imajin-ai/issues/2497) | [coffee](https://github.com/ima-jin/coffee/blob/main/README.md) |
| dykil | Surveys and responses | Standalone services serving; signed legacy import incomplete in [#2522](https://github.com/ima-jin/imajin-ai/issues/2522) | [dykil](https://github.com/ima-jin/dykil/blob/main/README.md) |
| events | Event pages, ticketing and check-in | Cutover accepted 2026-10-20 in [#2516](https://github.com/ima-jin/imajin-ai/issues/2516); buy/QR smoke deferred to [#2989](https://github.com/ima-jin/imajin-ai/issues/2989) | [events](https://github.com/ima-jin/events/blob/main/README.md) |
| learn | Courses and learning | Standalone prod + dev; cutover recorded in [#2502](https://github.com/ima-jin/imajin-ai/issues/2502) | [learn](https://github.com/ima-jin/learn/blob/main/README.md) |
| links | Link-in-bio pages | Own repository; monorepo copy pruned 2026-09-28 | [links](https://github.com/ima-jin/links/blob/main/README.md) |
| market | Listings and purchases | Standalone prod + dev; cutover recorded in [#2510](https://github.com/ima-jin/imajin-ai/issues/2510) | [market](https://github.com/ima-jin/market/blob/main/README.md) |

Events' cutover closed under the [2026-10-20 ruling](https://github.com/ima-jin/imajin-ai/issues/2516#issuecomment-6294184437): buy/QR smoke waits for a future event in #2989, and registry controls are tracked in [#2988](https://github.com/ima-jin/imajin-ai/issues/2988). The old kernel-copy rollback is retired; app rollback uses its own prior deployment ref. Dykil's [2026-10-20 import report](https://github.com/ima-jin/imajin-ai/issues/2522#issuecomment-6293818392) records a failed dev signature check and no prod import; serving standalone is not import acceptance.

The [prune-on-dev ruling](https://github.com/ima-jin/imajin-ai/issues/1981#issuecomment-6083425361) separates source removal from prod acceptance. Pruning does not drop app schema or data.

## Build an app

Start with the [app template's owned README](https://github.com/ima-jin/imajin-app-template/blob/main/README.md), preserving its history. Follow its registration, schema-ownership and claim instructions; [kernel provisioning](docs/REGISTRATION.md) documents the operator-managed path.

Use [`auth-client`](packages/auth-client/README.md) for sign-in and session handlers. Add published [`auth`](packages/auth/package.json), [`config`](packages/config/package.json), [`logger`](packages/logger/package.json), [`ui`](packages/ui/package.json) or [`fair`](packages/fair/package.json) only as needed.

```bash
npm install @ima-jin/auth-client@0.8.25
```

External consumers install **`@ima-jin/*` from npmjs.org anonymously**; workspace imports use **`@imajin/*`**. The [publish pipeline](docs/npm-publishing.md) rewrites the scope and removes `private: true` only in the publish copy. That flag is not publication evidence. Apps must not install workspace-only internals or access another service's database.

## Packages (SDK)

Generated from every `packages/*/package.json` at [`e34a1b43`](https://github.com/ima-jin/imajin-ai/tree/e34a1b43a3db6f169d6b2c1d19d22c3220f62376). Descriptions use manifest text, or current exports where a manifest has none. Anonymous public npm `latest` checks on **2026-10-21 UTC** found **12 published, 18 workspace-only**. Versions are a checked snapshot; registry links show live metadata. SDK tracking: [#1982](https://github.com/ima-jin/imajin-ai/issues/1982), [#1581](https://github.com/ima-jin/imajin-ai/issues/1581), [#1011](https://github.com/ima-jin/imajin-ai/issues/1011), [#1992](https://github.com/ima-jin/imajin-ai/issues/1992).

### Core SDK and workspace libraries

| Workspace package | What it provides | Publish status |
|---|---|---|
| [`@imajin/auth`](packages/auth/package.json) | Authentication, scoped authorization, DID helpers, signing and verification | [`@ima-jin/auth@0.8.25`](https://registry.npmjs.org/@ima-jin/auth/latest) |
| [`@imajin/auth-client`](packages/auth-client/package.json) | "Sign in with Imajin" SDK for federated apps — JWT session management and ready-made Next.js route handlers | [`@ima-jin/auth-client@0.8.25`](https://registry.npmjs.org/@ima-jin/auth-client/latest) |
| [`@imajin/bus`](packages/bus/package.json) | Event publishing, consent brokering and ordered reactor chains | Workspace-only; npm 404 |
| [`@imajin/chat`](packages/chat/package.json) | Chat components, message rendering and real-time hooks | Workspace-only; npm 404 |
| [`@imajin/cid`](packages/cid/package.json) | Deterministic CIDv1 (dag-cbor + SHA-256) helpers shared across Imajin services | [`@ima-jin/cid@0.8.25`](https://registry.npmjs.org/@ima-jin/cid/latest) |
| [`@imajin/config`](packages/config/package.json) | Shared configuration for Imajin services — CORS, service routing, session config, handle validation, and route helpers | [`@ima-jin/config@0.8.25`](https://registry.npmjs.org/@ima-jin/config/latest) |
| [`@imajin/db`](packages/db/package.json) | Drizzle/postgres database handle shared across Imajin services | [`@ima-jin/db@0.8.25`](https://registry.npmjs.org/@ima-jin/db/latest) |
| [`@imajin/dfos`](packages/dfos/package.json) | DFOS identity-chain verification and content publishing | Workspace-only; npm 404 |
| [`@imajin/email`](packages/email/package.json) | Email delivery, templates and QR generation | Workspace-only; npm 404 |
| [`@imajin/emit`](packages/emit/package.json) | Service-scoped operational event emission | Workspace-only; npm 404 |
| [`eslint-config-imajin`](packages/eslint-config-imajin/package.json) | Shared ESLint flat config for imajin-ai monorepo | Workspace-only; npm 404 |
| [`@imajin/fair`](packages/fair/package.json) | Shared .fair attribution types, validator, builder, and React components | [`@ima-jin/fair@0.8.25`](https://registry.npmjs.org/@ima-jin/fair/latest) |
| [`@imajin/input`](packages/input/package.json) | Composable text, voice, location and attachment inputs | Workspace-only; npm 404 |
| [`@imajin/llm`](packages/llm/package.json) | Vercel AI SDK provider factory and usage-cost calculation | Workspace-only; npm 404 |
| [`@imajin/logger`](packages/logger/package.json) | Structured logging and request middleware | [`@ima-jin/logger@0.8.25`](https://registry.npmjs.org/@ima-jin/logger/latest) |
| [`@imajin/media`](packages/media/package.json) | Media browser, asset display components, and resolveMediaRef/resolveAssetUrl helpers for Imajin apps | [`@ima-jin/media@0.8.25`](https://registry.npmjs.org/@ima-jin/media/latest) |
| [`@imajin/money`](packages/money/package.json) | Currency-safe Money primitive, signed FX snapshots, and ECB rate cache-through (#1950) | Workspace-only; npm 404 |
| [`@imajin/notify`](packages/notify/package.json) | Credential-provider-backed notification and broadcast client | Workspace-only; npm 404 |
| [`@imajin/onboard`](packages/onboard/package.json) | OnboardGate — React component that gates a page behind Imajin onboarding (handle/identity setup) | [`@ima-jin/onboard@0.8.25`](https://registry.npmjs.org/@ima-jin/onboard/latest) |
| [`@imajin/provision-bootstrap`](packages/provision-bootstrap/package.json) | Build-time ESM compile of scripts/lib/provision-service-bootstrap.ts (+ the kernel sources it imports) for scripts/provision-service-bootstrap.mjs (#2485) | Workspace-only; npm 404 |
| [`@imajin/tokens`](packages/tokens/package.json) | Imajin design tokens — DTCG format, built with Style Dictionary v4 | [`@ima-jin/tokens@0.8.25`](https://registry.npmjs.org/@ima-jin/tokens/latest) |
| [`@imajin/trust-graph`](packages/trust-graph/package.json) | Pod membership traversal and trust-graph queries | Workspace-only; npm 404 |
| [`@imajin/ui`](packages/ui/package.json) | Shared UI components for Imajin apps — NavBar, identity management, app launcher, theming, and common patterns | [`@ima-jin/ui@0.8.25`](https://registry.npmjs.org/@ima-jin/ui/latest) |
| [`@imajin/vault-core`](packages/vault-core/package.json) | Vault entry models, integrity verification, sealing and delegation primitives for Imajin nodes | [`@ima-jin/vault-core@0.8.25`](https://registry.npmjs.org/@ima-jin/vault-core/latest) |

### Plugin and harness surface

The [OpenClaw Imajin plugin](https://github.com/ima-jin/openclaw-imajin-plugin/blob/main/README.md) is owned outside this workspace. Its related channel, inference passthrough, reflex guard, envelope, provisioner and usage-emitter packages form a separate group below. No npm installation is claimed for these workspace-only packages.

| Workspace package | What it provides | Publish status |
|---|---|---|
| [`@imajin/claw-envelope`](packages/claw-envelope/package.json) | Harness-agnostic RFC-31 context-envelope generator (imajin-ai#1932/#1933): agent DID + owner DID + intent in, workspace files/config/delegation-grant refs/bus routes out — plus a NanoClaw renderer and the agent identity bootstrap CLI. | Workspace-only; npm 404 |
| [`@imajin/claw-provisioner`](packages/claw-provisioner/package.json) | Operator-executed runner for the envelope provisioner (imajin-ai#1933): consumes a kernel provision record, materializes its rendered envelope, and (for hosted placements, non-dry-run only) runs the deploy/nanoclaw compose stack, reporting boot status back to the kernel. Never touches live infra by itself in this repo's tests/CI. | Workspace-only; npm 404 |
| [`@imajin/nanoclaw-imajin-channel`](packages/nanoclaw-imajin-channel/package.json) | Imajin chat bridge for a NanoClaw instance (imajin-ai#1932): a NanoClaw ChannelAdapter reachable at its own agent DID via the existing jin.imajin.ai chat channel, plus the MCP token-refresh proxy and usage.incurred emitter sidecars it depends on. | Workspace-only; npm 404 |
| [`@imajin/openclaw-infer-passthrough`](packages/openclaw-infer-passthrough/package.json) | Local OpenAI-compatible HTTP proxy (imajin-ai#1926, Phase 4 of the #1922 inference connectors epic): mints kernel app-token JWTs on OpenClaw's behalf and forwards custom-provider completions calls to POST /infer/v1/chat/completions, with break-glass direct fallback on kernel 5xx/timeout. | Workspace-only; npm 404 |
| [`@imajin/openclaw-reflex-guard`](packages/openclaw-reflex-guard/package.json) | OpenClaw plugin: post-turn instruction-check guard (imajin-ai#1252) — deterministic outbound sealed-term guard (Layer 1) + fuzzy reflex scaffold (Layer 2) | Workspace-only; npm 404 |
| [`@imajin/usage-emitter-claude-code`](packages/usage-emitter-claude-code/package.json) | Reference external usage.incurred emitter (#1151): tails Claude Code session JSONL and posts to POST /usage/api/incurred. | Workspace-only; npm 404 |

## Run a node

For a local kernel, install **Node.js 22+, pnpm 9 and PostgreSQL 14+** with client tools. The [setup helper](scripts/setup-local.sh) prepares local kernel dependencies, environment, migrations and service bootstrap identities; it does not set up extracted apps.

```bash
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai
bash scripts/setup-local.sh
pnpm --filter @imajin/kernel dev
```

Open `http://localhost:3000/register` and save your key file. The helper disables the invite gate **for local development only**; production registration remains policy-gated. The command starts only the kernel, unlike workspace-wide `pnpm dev`.

Details: [local development](docs/DEVELOPER.md) · [deployment](deploy/README.md) · [environment reference](docs/ENVIRONMENTS.md). Production uses reviewed, approval-gated release/deploy workflows, not a manual `git pull`. Extracted apps follow their own runbooks.

## Project status

<!-- stats:start -->
Generated 2026-10-21 UTC from source commit [`e34a1b43`](https://github.com/ima-jin/imajin-ai/commit/e34a1b43a3db6f169d6b2c1d19d22c3220f62376); full-history repository snapshot, not live deployment metrics.

| Repository metric | Computed value |
|---|---|
| Reachable commits (`git rev-list --count e34a1b43`, full history) | 5880 |
| `apps/*/package.json` | 3 (includes kernel and internal services) |
| `packages/*/package.json` | 30 |
<!-- stats:end -->

No live identity count or unsigned inference-cost estimate is asserted. See the [signed usage-rollup read model](apps/kernel/app/usage/api/rollup/[did]/latest/route.ts) for the per-DID record, not a guessed network total.

## Docs / RFCs / spec

- [Developer guide index](docs/guide/README.md) · [proof model](docs/guide/proof-model.md) · [migrations](docs/MIGRATIONS.md).
- [Whitepaper](docs/mjn-whitepaper.md) · [RFC index](docs/rfcs/INDEX.md) · [operator API spec source](apps/kernel/app/jin/api/spec/route.ts).
- [Conformance #1287](https://github.com/ima-jin/imajin-ai/issues/1287) tracks the assembled node suite. This README does not assert certification.
- The Canadian reference-build company / proposed Swiss protocol-steward split remains a [memo and conformance dependency](https://github.com/ima-jin/imajin-ai/issues/1287), not a claim that the proposed entity exists.
- [Build log](apps/kernel/content/build-log.md) · [process log](apps/kernel/content/process-log.md). Historical entries retain their dates.

Linked documents can lag implementation. [#2028](https://github.com/ima-jin/imajin-ai/issues/2028) holds the standing replay brief and run-logs; this pre-cut replay regenerates READMEs only, not the whitepaper or log files.

## Contributing

Read [AGENTS.md](AGENTS.md), [canonical patterns](docs/guide/canonical-patterns.md) and the [PR checklist](docs/PR-CHECKLIST.md). Work in an isolated worktree and submit a PR. Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`. Release workflows alone bump manifest versions.

## Security

See [SECURITY.md](SECURITY.md) for disclosure and known limitations. User signatures, node assertions and operational logs are different guarantees; use the [proof model](docs/guide/proof-model.md), not the hero, to decide what a verifier can establish.

## A note on use

A general-purpose tool can be used well or badly. The commitment is legibility, not a promise to make misuse impossible: authority, disclosure and signed actions should leave an inspectable record, including our own. A signature establishes who asserted a claim, not that it is true. Soft-DID activity and unsigned operational logs are not user signatures.

The [honest-record accountability issue #1427](https://github.com/ima-jin/imajin-ai/issues/1427) closed on 2026-09-23 after the [resolver](https://github.com/ima-jin/imajin-ai/pull/1454) and [durable audit-log](https://github.com/ima-jin/imajin-ai/pull/1500) gaps shipped. That closes those tracked gaps, not every security or revocation-propagation use case. Consult the implementation, known limitations and license.

## License

[Imajin Network License (INL) v1.0](LICENSE.md), **not MIT**. Source-available, with notice requirements for everyone and network-participation conditions for covered commercial organizations above the CAD $1 million annual-revenue threshold. The license defines the conditions and exemptions; this summary does not replace it.
