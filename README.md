# Imajin

**You compose. Imajin orchestrates. Signed. Legible.**

You choose your tools, bring your identity and compose work with people and agents. Connect a service, authorize an app or inspect a signed record without becoming the object being managed — *the speed of thought, signed.*

## What it is

Imajin is **Agentic Relation Management**: the relation is at the center, with agents on both sides. Its kernel serves **Attestation · Communication · Attribution · Settlement · Discovery · Revocation**, plus identity/auth, the bus, connectors, inference and media. Identity is their subject, not another primitive.

**Proof of history, not proof of work:** signatures and linked records establish who asserted what and under whose authority, not that every assertion is true. Actor signatures, node-witnessed actions and unsigned logs have distinct guarantees. See the [proof model](docs/guide/proof-model.md) and [whitepaper](docs/mjn-whitepaper.md).

Revocation withdraws authority while retaining its tombstone and provenance. Erasing content or wrapped key material is not deletion of signed history. Do not infer that every propagation use case is implemented from the primitive's name.

## What you can do

- Run a kernel and compose identity, profile, connection, messaging and media services.
- Connect an agent through the [OpenClaw plugin](https://github.com/ima-jin/openclaw-imajin-plugin), or build a registered app with the published SDK.
- Act as a business or organization under live role and allowed-service checks, without confusing the human controller with the acting DID.
- Connect provider accounts, discover usable inference models and authorize app operations without handing apps raw provider keys.
- Manage org-held keys and member grants on `/auth/connectors`, where members read key status as metadata only; org owners/admins renew key expiry from `/jin/vault/renew` through countersigned approval.
- Let an agent discover its own identity, usable models, inference routes and read-only MCP/HTTP connector authority through `GET /infer/v1/self`; operators see the same cards on `/jin`.
- Send mail as an org's verified custom domain through the node's Postal server, set up under **Organization settings** on `/jin` ([guide](docs/guide/domain-ownership.md#mail-domains)).
- Inspect signed records, consent, grants and actionable approvals while retaining revoked and expired history.
- Attribute content and settle supported payment flows using the owning service's contract.

The [kernel guide](apps/kernel/README.md) explains these capabilities and their limits. Chat uses TLS in transit and stores plaintext at rest on the hosting node in `chat.messages_v2.content`. Push notifications carry the first 200 characters of the message preview. Message encryption is planned but not implemented; public key bundles do not protect current messages. See [security disclosures](SECURITY.md).

## Kernel vs. apps

A node operator runs the kernel, not a calendar. Apps built on Imajin have their own identities and repositories, use scoped tokens and public APIs, and never import kernel internals or read another service's tables. Follow the [registered-app contract](docs/REGISTRATION.md).

| Workspace directory | Responsibility | Owned README |
|---|---|---|
| `apps/kernel` | The six primitives and their shared rails | [Kernel](apps/kernel/README.md) |
| `apps/broker-agent` | Internal Telegram broker agent surface | [Broker-agent](apps/broker-agent/README.md) |
| `apps/corpus` | Internal owner-DID retrieval daemon | [Corpus](apps/corpus/README.md) |

Independently owned apps have separate build, API and deployment contracts:

| App | What you compose | Owned README |
|---|---|---|
| coffee | Tips and support | [Coffee](https://github.com/ima-jin/coffee/blob/main/README.md) |
| dykil | Surveys and responses | [Dykil](https://github.com/ima-jin/dykil/blob/main/README.md) |
| events | Event pages, ticketing and check-in | [Events](https://github.com/ima-jin/events/blob/main/README.md) |
| learn | Courses and learning | [Learn](https://github.com/ima-jin/learn/blob/main/README.md) |
| links | Link-in-bio pages | [Links](https://github.com/ima-jin/links/blob/main/README.md) |
| market | Listings and purchases | [Market](https://github.com/ima-jin/market/blob/main/README.md) |

Source extraction is not operational acceptance or proof of a legacy import. App schemas and data remain owned by their apps; rollback uses each app's reviewed prior deployment ref, not a removed kernel copy.

## Build an app

Start from the [app template](https://github.com/ima-jin/imajin-app-template/blob/main/README.md) and [registration contract](docs/REGISTRATION.md). Use [auth-client](packages/auth-client/README.md) for app-owned sign-in and isolated session handlers; add other published SDK packages only as needed.

```bash
npm install @ima-jin/auth-client
```

External consumers use `@ima-jin/*`; workspace imports use `@imajin/*`. The [publish pipeline](docs/npm-publishing.md) rewrites the scope and strips the private flag in the publish copy. That flag is not evidence of publication status. A registry link below is live package metadata, not a pinned compatibility promise.

## Packages (SDK)

The inventory follows workspace manifests. Libraries without public npm metadata remain workspace-only; do not infer an installation command from a workspace import.

### Core SDK and workspace libraries

| Workspace package | What it provides | External availability |
|---|---|---|
| [`@imajin/auth`](packages/auth/package.json) | Authentication, scoped authorization, DID helpers, signing and verification | [npm metadata](https://registry.npmjs.org/@ima-jin/auth/latest) |
| [`@imajin/auth-client`](packages/auth-client/package.json) | App sign-in, isolated sessions, signing-key bootstrap and vault boot | [npm metadata](https://registry.npmjs.org/@ima-jin/auth-client/latest) |
| [`@imajin/bus`](packages/bus/package.json) | Event publishing, consent brokering and ordered reactor chains | Workspace-only (not on public npm) |
| [`@imajin/chat`](packages/chat/package.json) | Chat components, message rendering and real-time hooks | Workspace-only (not on public npm) |
| [`@imajin/cid`](packages/cid/package.json) | Deterministic content identifier helpers | [npm metadata](https://registry.npmjs.org/@ima-jin/cid/latest) |
| [`@imajin/config`](packages/config/package.json) | Service routing, CORS, session configuration and route helpers | [npm metadata](https://registry.npmjs.org/@ima-jin/config/latest) |
| [`@imajin/db`](packages/db/package.json) | Shared Postgres and Drizzle database primitives | [npm metadata](https://registry.npmjs.org/@ima-jin/db/latest) |
| [`@imajin/dfos`](packages/dfos/package.json) | Identity-chain verification and content publishing | Workspace-only (not on public npm) |
| [`@imajin/email`](packages/email/package.json) | Email delivery, templates and QR generation | Workspace-only (not on public npm) |
| [`@imajin/emit`](packages/emit/package.json) | Service-scoped operational event emission | Workspace-only (not on public npm) |
| [`eslint-config-imajin`](packages/eslint-config-imajin/package.json) | Shared flat lint configuration | Workspace-only (not on public npm) |
| [`@imajin/fair`](packages/fair/package.json) | Attribution types, validation, manifest building and React components | [npm metadata](https://registry.npmjs.org/@ima-jin/fair/latest) |
| [`@imajin/input`](packages/input/package.json) | Composable text, voice, location and attachment inputs | Workspace-only (not on public npm) |
| [`@imajin/llm`](packages/llm/package.json) | Provider adapters, tool contracts and usage-cost calculation | Workspace-only (not on public npm) |
| [`@imajin/logger`](packages/logger/package.json) | Structured logging and request middleware | [npm metadata](https://registry.npmjs.org/@ima-jin/logger/latest) |
| [`@imajin/media`](packages/media/package.json) | Media browser, asset display and reference resolution | [npm metadata](https://registry.npmjs.org/@ima-jin/media/latest) |
| [`@imajin/money`](packages/money/package.json) | Currency-safe amounts, signed FX snapshots and rate caching | Workspace-only (not on public npm) |
| [`@imajin/notify`](packages/notify/package.json) | Credential-provider-backed notification and broadcast client | Workspace-only (not on public npm) |
| [`@imajin/onboard`](packages/onboard/package.json) | Identity onboarding gate for app pages | [npm metadata](https://registry.npmjs.org/@ima-jin/onboard/latest) |
| [`@imajin/provision-bootstrap`](packages/provision-bootstrap/package.json) | Compiled service-bootstrap provisioning entrypoint | Workspace-only (not on public npm) |
| [`@imajin/tokens`](packages/tokens/package.json) | Shared design tokens | [npm metadata](https://registry.npmjs.org/@ima-jin/tokens/latest) |
| [`@imajin/trust-graph`](packages/trust-graph/package.json) | Pod membership traversal and trust-graph queries | Workspace-only (not on public npm) |
| [`@imajin/ui`](packages/ui/package.json) | Shared interface components, identity management and theming | [npm metadata](https://registry.npmjs.org/@ima-jin/ui/latest) |
| [`@imajin/vault-core`](packages/vault-core/package.json) | Vault models, integrity verification, sealing and delegation | [npm metadata](https://registry.npmjs.org/@ima-jin/vault-core/latest) |

### Plugin and harness surface

The external OpenClaw plugin and workspace envelope, provisioner, channel, inference transport, reflex guard and usage emitter have distinct responsibilities. Calling-agent inference has no shared-credential fallback; explicit non-agent host compatibility is a separate deployment mode.

| Workspace package | What it provides | External availability |
|---|---|---|
| [`@imajin/claw-envelope`](packages/claw-envelope/package.json) | Harness-neutral context envelopes and agent bootstrap | Workspace-only (not on public npm) |
| [`@imajin/claw-provisioner`](packages/claw-provisioner/package.json) | Operator-executed provision-record and envelope runner | Workspace-only (not on public npm) |
| [`@imajin/nanoclaw-imajin-channel`](packages/nanoclaw-imajin-channel/package.json) | DID-addressed chat bridge and token/usage sidecars | Workspace-only (not on public npm) |
| [`@imajin/openclaw-infer-passthrough`](packages/openclaw-infer-passthrough/package.json) | Calling-agent credential transport to kernel inference, with explicit non-agent host compatibility | Workspace-only (not on public npm) |
| [`@imajin/openclaw-reflex-guard`](packages/openclaw-reflex-guard/package.json) | Deterministic outbound instruction checks and reflex scaffold | Workspace-only (not on public npm) |
| [`@imajin/usage-emitter-claude-code`](packages/usage-emitter-claude-code/package.json) | External incurred-usage emitter from local session observations | Workspace-only (not on public npm) |

## Run a node

Use Node.js, pnpm and PostgreSQL with the prerequisites in [contributor setup](docs/DEVELOPER.md). The setup helper prepares a local kernel database and environment, not independently owned apps.

```bash
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai
bash scripts/setup-local.sh
pnpm --filter @imajin/kernel dev
```

Open `http://localhost:3000/register` and save your key file. The setup helper disables the invite gate for local development only; production remains policy-gated. [Deployment](deploy/README.md), [deploy posture](docs/ops/DEPLOY-POSTURE.md) and [environment configuration](docs/ENVIRONMENTS.md) describe approved operator procedures. Do not deploy production with a manual `git pull`.

## Project status

Source inventories are available through the workspace manifests above. Signed per-DID usage is exposed by the [usage contract](https://jin.imajin.ai/usage/api/spec). No static identity total, unsigned inference-cost estimate or stale repository metric is asserted.

## Docs / RFCs / spec

- [Integration guide](docs/developer-guide.md) and [guide index](docs/guide/README.md).
- [llms.txt](apps/kernel/public/llms.txt) and [llms-full.txt](apps/kernel/public/llms-full.txt): concepts, integration flows and links to every defined service spec. The live specs are the route catalogue.
- [Canonical patterns](docs/guide/canonical-patterns.md), [migration discipline](docs/MIGRATIONS.md) and [whitepaper](docs/mjn-whitepaper.md).
- [RFC index](docs/canon/rfcs/INDEX.md): design records with their own status, not a claim that every proposal is implemented.
- [Build log](apps/kernel/content/build-log.md) and [process log](apps/kernel/content/process-log.md): historical records, separate from current-state consumer guidance.

## Contributing

Read [AGENTS.md](AGENTS.md), [canonical patterns](docs/guide/canonical-patterns.md) and the [PR checklist](docs/PR-CHECKLIST.md). Work in an isolated worktree. Use the agent build/lint/typecheck commands, run affected tests while iterating, and run `pnpm --silent test:agent` for final validation. Only the reviewed release workflow changes manifest versions.

### SonarCloud on fork PRs

The required SonarCloud CI job is a compatibility skip on forks and warns **NOT SCANNED**, because forks do not receive the scan token. The separate trusted follow-up runs from reviewed main after CI, with no checkout, install or execution of PR code. It authenticates the CI run and unique open PR by exact head and treats regular Git blobs and validated coverage as untrusted scan data.

Trusted settings come from the main base outside the source tree. Fork-side scanner settings, workflow edits and ignore-file changes cannot widen privileged authority or narrow the trusted scan. Malformed data, ambiguous PRs, failed/cancelled CI and stale heads fail closed.

Use **`sonarcloud/trusted` on the exact head SHA** as fork scan evidence. Its submitted analysis task must report quality gate OK. Same-repo PR and main analyses use the ordinary CI path; main has no open PR by design, and the fork follow-up skips non-PR and same-repo runs.

Gate OK alone does not establish Sonar 0: also verify zero OPEN/CONFIRMED issues and the analysis revision. A PR changing the privileged workflow cannot prove its candidate post-merge path before merge. Verify that path through an intended open fork PR after the reviewed workflow is on main; never expose the token to PR code or push a fork branch to the org to bypass the boundary.

## Security

Read [SECURITY.md](SECURITY.md) for disclosure and implementation limits. Preserve distinctions among user signatures, node assertions and operational logs. A spec and passing source tests do not establish live deployment, federation acceptance or host custody configuration.

## A note on use

A general-purpose tool can be used well or badly. The commitment is legibility, not a promise to make misuse impossible: authority, disclosure and signed actions should leave an inspectable record, including our own. A signature establishes who asserted a claim, not its truth. Soft-identity activity and unsigned logs are not user signatures.

Inspect the proof model and current security boundaries rather than treating an accountability promise as evidence that every security or revocation-propagation use case is implemented.

## License

[Imajin Network License](LICENSE.md), **not MIT**. Source-available, with notice requirements and network-participation conditions for covered commercial organizations above CAD $1 million annual revenue. The license defines conditions and exemptions; this summary does not replace it.
