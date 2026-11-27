# Imajin

**identity and authority for AI agents.**

your agents act as themselves, on your authority, and every action is signed.

Imajin is the trust layer for AI agents, for businesses putting agents in front of
customers or staff, and platforms and agencies running agents for many clients.
**Alpha:** [book a demo or join the alpha](https://imajin.ai/alpha) as a tester, integrator or partner.

1. **Agent identity.** Every agent holds its own key and proves it, with no shared
   passwords or API tokens. Several identities can run on one runtime, each for
   its own principal. The agent never impersonates the person.
2. **Delegated authority.** A person grants authority explicitly and can revoke it.
   Risky actions wait for a named human approver. The record shows both: the person
   authorised it, and the agent did it.
3. **A signed record and settlement.** Every action is a signed event that anyone
   can verify, including a third party's own agent. Cost and credit are recorded
   per identity, and .fair turns that into who gets paid.

## Quickstart: run a node

Use Node.js, pnpm and PostgreSQL with the prerequisites in [contributor setup](docs/DEVELOPER.md). The setup helper prepares a local kernel database and environment, not independently owned apps.

```bash
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai
bash scripts/setup-local.sh
pnpm --filter @imajin/kernel dev
```

Open `http://localhost:3000/register` and save your key file. The helper disables the invite gate for local development only; production remains policy-gated. Use [deployment](deploy/README.md), [deploy posture](docs/ops/DEPLOY-POSTURE.md) and [environment configuration](docs/ENVIRONMENTS.md) for reviewed operator procedures, never a manual production `git pull`.

## What it is

The kernel serves **Attestation · Communication · Attribution · Settlement · Discovery · Revocation**, plus identity/auth, the bus, connectors, inference and media. Identity is their subject, not another primitive.

**Proof of history, not proof of work:** signatures and linked records establish who asserted what and under whose authority, not that every assertion is true. Actor signatures, node-witnessed records and unsigned logs have different guarantees. Read the [proof model](docs/guide/proof-model.md) and [whitepaper](docs/mjn-whitepaper.md).

Revocation withdraws authority while retaining tombstones and provenance. Erasing content or wrapped keys is not deletion of signed history; the primitive's name is not proof of universal propagation.

## What you can do

- Run a kernel and compose identity, profile, connection, messaging and media services.
- Connect an agent through the [OpenClaw plugin](https://github.com/ima-jin/openclaw-imajin-plugin) or build a registered app with the published SDK.
- Create an agent using the acting owner's base handle and optional suffix, with explicit collision handling; personal creation and organization provisioning have separate authority checks.
- Act as an organization under live role and allowed-service checks, keeping the human controller and acting DID separate.
- Connect providers, discover usable models and authorize scoped operations without giving apps raw provider keys. Billing and inference use distinct credentials.
- Manage org-held keys and member grants on `/auth/connectors`; owners/admins renew expiry from `/jin/vault/renew` through countersigned approval.
- Discover an agent's own identity, models and read-only connector authority through `GET /infer/v1/self`; operators see serving-agent cards on `/jin`.
- Clone/fetch GitHub repositories through the agent-mode loopback proxy and the owner's live `github:read` grant, without a GitHub login or token on the agent host. Push is refused; [repository access limits](docs/agents/github-git-read-proxy.md) still apply.
- Send mail as an org's verified custom domain through the node's Postal server, configured under Organization settings on `/jin` ([guide](docs/guide/domain-ownership.md#mail-domains)).
- Inspect signed records, consent, grants and actionable approvals while retaining expired and revoked history.
- Attribute content and settle supported payment flows through the owning service's contract.

The [kernel guide](apps/kernel/README.md) explains limits and integration details. Chat uses TLS in transit and stores plaintext at rest on the hosting node in `chat.messages_v2.content`. Push notifications carry the first 200 characters of the message preview. Message encryption is planned but not implemented; public key bundles do not protect current messages. See [security disclosures](SECURITY.md).

## Kernel vs. apps

A node operator runs the kernel, not a calendar. Apps built on Imajin have separate identities, repositories and deployment contracts. They use scoped public APIs, not kernel-internal imports or another service's tables. Follow the [registered-app contract](docs/REGISTRATION.md).

| Workspace directory | Responsibility | Owned README |
|---|---|---|
| `apps/broker-agent` | Internal Telegram broker agent surface | [broker-agent](apps/broker-agent/README.md) |
| `apps/corpus` | Internal owner-DID retrieval daemon | [corpus](apps/corpus/README.md) |
| `apps/kernel` | The six primitives and shared rails; not a third-party app | [kernel](apps/kernel/README.md) |

Independently owned apps:

| App | What you compose | Owned README |
|---|---|---|
| coffee | Tips and support | [coffee](https://github.com/ima-jin/coffee/blob/main/README.md) |
| dykil | Surveys and responses | [dykil](https://github.com/ima-jin/dykil/blob/main/README.md) |
| events | Event pages, tickets and check-in | [events](https://github.com/ima-jin/events/blob/main/README.md) |
| learn | Courses and learning | [learn](https://github.com/ima-jin/learn/blob/main/README.md) |
| links | Link-in-bio pages | [links](https://github.com/ima-jin/links/blob/main/README.md) |
| market | Listings and purchases | [market](https://github.com/ima-jin/market/blob/main/README.md) |

Source extraction is not operational acceptance or proof of a legacy import. App schemas and data stay app-owned; rollback uses each app's reviewed prior deployment ref, not a removed kernel copy.

## Build an app

Start from the [app template](https://github.com/ima-jin/imajin-app-template/blob/main/README.md) and [registration contract](docs/REGISTRATION.md). Use [auth-client](packages/auth-client/README.md) for app-owned sign-in and isolated session handlers; add other published SDKs only as needed.

```bash
npm install @ima-jin/auth-client
```

External consumers use `@ima-jin/*`; workspace imports use `@imajin/*`. The [publish pipeline](docs/npm-publishing.md) rewrites scope and strips the private flag in the publish copy. That flag is not publication evidence. Registry links below are live metadata, not pinned compatibility promises.

## Packages (SDK)

Rows are generated from workspace manifests, with source-grounded summaries where needed. Public availability is checked against anonymous npm metadata, never inferred from `private: true`.

### Core SDK and workspace libraries

| Workspace package | What it provides | External availability |
|---|---|---|
| [`@imajin/auth`](packages/auth/package.json) | Authentication, scoped authorization, DID helpers, signing and verification | [npm metadata](https://registry.npmjs.org/@ima-jin/auth/latest) |
| [`@imajin/auth-client`](packages/auth-client/package.json) | App sign-in, session management and Next.js route handlers | [npm metadata](https://registry.npmjs.org/@ima-jin/auth-client/latest) |
| [`@imajin/bus`](packages/bus/package.json) | Event publishing, consent brokering and ordered reactor chains | Workspace-only (not on public npm) |
| [`@imajin/chat`](packages/chat/package.json) | Chat components, message rendering and real-time hooks | Workspace-only (not on public npm) |
| [`@imajin/cid`](packages/cid/package.json) | Deterministic CIDv1 helpers | [npm metadata](https://registry.npmjs.org/@ima-jin/cid/latest) |
| [`@imajin/config`](packages/config/package.json) | Service routing, session configuration and route helpers | [npm metadata](https://registry.npmjs.org/@ima-jin/config/latest) |
| [`@imajin/db`](packages/db/package.json) | Shared Postgres and Drizzle database primitives | [npm metadata](https://registry.npmjs.org/@ima-jin/db/latest) |
| [`@imajin/dfos`](packages/dfos/package.json) | Identity-chain verification and content publishing | Workspace-only (not on public npm) |
| [`@imajin/email`](packages/email/package.json) | Email delivery, templates and QR generation | Workspace-only (not on public npm) |
| [`@imajin/emit`](packages/emit/package.json) | Service-scoped operational event emission | Workspace-only (not on public npm) |
| [`eslint-config-imajin`](packages/eslint-config-imajin/package.json) | Shared ESLint flat config for imajin-ai monorepo | Workspace-only (not on public npm) |
| [`@imajin/fair`](packages/fair/package.json) | Attribution types, validation, manifest building and React components | [npm metadata](https://registry.npmjs.org/@ima-jin/fair/latest) |
| [`@imajin/input`](packages/input/package.json) | Composable text, voice, location and attachment inputs | Workspace-only (not on public npm) |
| [`@imajin/llm`](packages/llm/package.json) | Provider adapters, tool contracts and usage-cost calculation | Workspace-only (not on public npm) |
| [`@imajin/logger`](packages/logger/package.json) | Structured logging and request middleware | [npm metadata](https://registry.npmjs.org/@ima-jin/logger/latest) |
| [`@imajin/media`](packages/media/package.json) | Media browser, asset display and reference resolution | [npm metadata](https://registry.npmjs.org/@ima-jin/media/latest) |
| [`@imajin/money`](packages/money/package.json) | Currency-safe amounts, signed FX snapshots and rate caching | Workspace-only (not on public npm) |
| [`@imajin/notify`](packages/notify/package.json) | Credential-provider-backed notification and broadcast client | Workspace-only (not on public npm) |
| [`@imajin/onboard`](packages/onboard/package.json) | React onboarding gate for handle and identity setup in Imajin apps (alpha). | [npm metadata](https://registry.npmjs.org/@ima-jin/onboard/latest) |
| [`@imajin/provision-bootstrap`](packages/provision-bootstrap/package.json) | Compiled service-bootstrap provisioning entrypoint | Workspace-only (not on public npm) |
| [`@imajin/tokens`](packages/tokens/package.json) | Design tokens | [npm metadata](https://registry.npmjs.org/@ima-jin/tokens/latest) |
| [`@imajin/trust-graph`](packages/trust-graph/package.json) | Pod membership traversal and trust-graph queries | Workspace-only (not on public npm) |
| [`@imajin/ui`](packages/ui/package.json) | Shared UI components and theming | [npm metadata](https://registry.npmjs.org/@ima-jin/ui/latest) |
| [`@imajin/vault-core`](packages/vault-core/package.json) | Vault models, integrity verification, sealing and delegation | [npm metadata](https://registry.npmjs.org/@ima-jin/vault-core/latest) |

### Plugin and harness surface

The external plugin, envelope, provisioner, channel, transport, reflex guard and usage emitter have distinct responsibilities. Calling-agent transport has no shared-credential fallback. Explicit non-agent host compatibility is a separate deployment mode.

| Workspace package | What it provides | External availability |
|---|---|---|
| [`@imajin/claw-envelope`](packages/claw-envelope/package.json) | Harness-neutral context envelopes and agent identity bootstrap | Workspace-only (not on public npm) |
| [`@imajin/claw-provisioner`](packages/claw-provisioner/package.json) | Operator-executed provision-record and envelope runner | Workspace-only (not on public npm) |
| [`@imajin/nanoclaw-imajin-channel`](packages/nanoclaw-imajin-channel/package.json) | DID-addressed chat bridge and token/usage sidecars | Workspace-only (not on public npm) |
| [`@imajin/openclaw-infer-passthrough`](packages/openclaw-infer-passthrough/package.json) | Calling-agent inference, MCP and read-only GitHub transport; isolated non-agent host compatibility | Workspace-only (not on public npm) |
| [`@imajin/openclaw-reflex-guard`](packages/openclaw-reflex-guard/package.json) | Deterministic outbound instruction checks and reflex scaffold | Workspace-only (not on public npm) |
| [`@imajin/usage-emitter-claude-code`](packages/usage-emitter-claude-code/package.json) | External incurred-usage observations from local harness sessions | Workspace-only (not on public npm) |

## Project status

Use the manifests above for source inventory and the [usage contract](https://jin.imajin.ai/usage/api/spec) for signed per-DID usage. No static identity count, unsigned inference-cost estimate or stale repository metric is asserted. Source and registry publication do not establish a production deployment.

## Docs / RFCs / spec

- [Integration guide](docs/developer-guide.md), [guide index](docs/guide/README.md) and [canonical positioning](docs/POSITIONING.md).
- [llms.txt](apps/kernel/public/llms.txt) and [llms-full.txt](apps/kernel/public/llms-full.txt): concepts, integration flows and links to service specs. Specs are the route catalogue.
- [Canonical patterns](docs/guide/canonical-patterns.md), [migration discipline](docs/MIGRATIONS.md) and [whitepaper](docs/mjn-whitepaper.md).
- [RFC index](docs/canon/rfcs/INDEX.md): design records with their own status, not proof that proposals or conformance targets are implemented.
- [Build log](apps/kernel/content/build-log.md) and [process log](apps/kernel/content/process-log.md): historical records, separate from current guidance.

## Contributing

Read [AGENTS.md](AGENTS.md), [canonical patterns](docs/guide/canonical-patterns.md) and the [PR checklist](docs/PR-CHECKLIST.md). Work in an isolated worktree. Run affected tests while iterating and `pnpm --silent test:agent` once for final validation; use agent build/lint/typecheck commands.

Only the reviewed Release workflow changes manifest versions. Its repository-scoped GitHub App installation token pushes the release branch and opens its PR; CI starts on the native `pull_request` event. Ryan provisions Contents and Pull requests read/write permissions on this repo only, the Actions variable `RELEASE_APP_ID` and secret `RELEASE_APP_PRIVATE_KEY`. Keep the Actions PR-creation setting OFF; no PAT, manual release PR, hand tag or bypass actor. See [release setup](docs/npm-publishing.md#cutting-a-release).

### SonarCloud on fork PRs

The ordinary SonarCloud CI job on forks is a compatibility skip marked **NOT SCANNED**: forks do not receive its token. A separate trusted follow-up runs from reviewed main after qualifying CI, authenticates the run and unique open PR by exact head, and treats Git blobs and validated coverage as untrusted data. It never checks out, installs or executes PR code.

Trusted settings come from the main base outside the source tree. Fork-side scanner, workflow and ignore changes cannot widen authority or narrow the trusted scan. Malformed data, ambiguous PRs, failed/cancelled CI and stale heads fail closed. Main and same-repo analyses use ordinary CI.

Check **`sonarcloud/trusted` on the exact head SHA**, its submitted analysis revision and quality gate OK, plus zero OPEN/CONFIRMED issues. No checks or a compatibility skip is not a scan. A privileged workflow change cannot prove its post-merge path before merge; verify it through an intended fork PR after review, never by exposing a token or pushing the fork branch to the org.

## Security

Read [SECURITY.md](SECURITY.md) for trust boundaries and implementation limits. User signatures, node assertions and logs are distinct. Specs and fixture tests do not prove live deployment, federation acceptance or host custody.

## A note on use

A general-purpose tool can be used well or badly. The commitment is legibility, not a promise to make misuse impossible: authority, disclosure and signed actions should leave an inspectable record, including our own. A signature establishes who asserted a claim, not its truth. Soft-identity activity and unsigned logs are not user signatures.

Inspect the proof model and current security limits rather than treating an accountability promise as evidence that every revocation or security use case is implemented.

## License

[Imajin Network License](LICENSE.md), **not MIT**. Source-available, with notice requirements and network-participation conditions for covered commercial organizations above CAD $1 million annual revenue. The license defines conditions and exemptions; this summary does not replace it.
