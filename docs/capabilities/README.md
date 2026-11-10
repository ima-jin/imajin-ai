# Imajin capability map

**Alpha · the trust layer for AI agents.** Identity and authority for AI agents.
This is a code-evidence inventory, not a deployment certificate or a promise of self-serve access.

- **Buyer path:** agent identity → explicit authority → a signed record and settlement.
- **Operator path:** choose the acting identity → review what needs approval → inspect the record and cost.
- **Scope:** every current app, shared package and local service spec; external community apps are integration boundaries, not locally graded products.
- **Use:** [machine-readable map](capabilities.yaml), [navigation proposal](#navigation-proposal), [positioning cut](#positioning-cut-for-3284), [gaps](#gaps).

## Snapshot and method

Snapshot: **2026-11-10**, source commit recorded in `capabilities.yaml` (`source_commit`).
The checkout has `apps/kernel`, `apps/corpus`, and `apps/broker-agent`. Most services run inside the kernel.
The map inventories user/agent jobs, not one row per route, exported helper or database table. Related verbs share a row only when their audience, authority boundary and grade agree.

`entry_points` names current UI paths, main API templates, SDKs and checked-in `/spec` source files.
The checked-in YAML is exactly the source served by service spec handlers; reading it avoids confusing a deployed older build with this snapshot.
Unspecified specs are explicitly `[]`, not fabricated contracts. `/mcp` tools and some connector routes have code but no separate local OpenAPI file.
Corpus paths are on its standalone server (`/spec`); kernel paths are node-relative. UI parameter syntax uses `[id]`, OpenAPI uses `{id}`.

Evidence links below are relative to this repository. The YAML carries **all** code/test/navigation paths, grade explanations, last-touched dates and related open issues.
`last_touched` is the latest source-evidence commit date from `git log -1 --format=%cs -- <code paths>` at the snapshot, not a docs edit date, deployment date or operational proof.
Open issues are a dated selection of relevant unresolved work, not a dependency-resolution claim. An empty list means no specific issue was identified in this pass.
Shared packages are implementation dependencies: `@imajin/tokens` contains **design tokens**, not currency.

### Grading rubric

- **Audience:** one primary audience per job: business buyer, org admin (manages agents), developer, operator, end user/consumer, agent (machine). Secondary uses do not duplicate rows.
- **Live:** working UI + API + tests **and a traced navigation home**. `evidence.navigation` identifies the tab/launcher/console source. This means wired in source, not independently browser-tested or proven deployed.
- **Works:** implemented API/tool/SDK + relevant tests; thin, indirect or unproven UI/nav. A page file alone does not earn live. Shared libraries use this grade for their callable API.
- **Partial:** stubs, missing end-to-end pieces, incomplete provider coverage or a known operational proof gap. The grade explanation names the limiting seam, even where individual primitives work.
- **Dormant:** no source commits for at least 60 days **and** no inbound links at the snapshot. Age alone and an undeployed package do not qualify. No row in this pass has evidence for both conditions; idle emitters remain partial, not silently called dormant.
- **Core business weight:** directly supplies agent identity, explicit/revocable authority, custody/approvals, attributable spend/audit or signed settlement. Core is importance, **not** readiness.
- **Supporting:** enables or demonstrates a pillar but is not the buyer's main reason to choose Imajin.
- **Side-effect:** consumer/community/legacy utility, useful but off the business front door.
- **Pillars:** `agent identity`, `delegated authority`, `signed record and settlement`, or `none` alone. A supporting or side-effect job may still exercise a pillar. Mere use of a DID does not make a capability core.

No grades are based on roadmap prose, package names, customer names or the existence of a spec alone.
Tests listed are evidence of behavior, not a claim that this run re-executed every product test individually.
Documented risks remain visible on live primitives; “live” does not mean feature-complete, compliant, highly available or universally append-only.

## Per-audience main jobs

- **Business buyer:** Determine whether an agent can act as itself on your authority, show who authorized its actions, and account for the resulting cost and settlement.
- **Org admin:** Give each agent the right principal, connections and bounded authority, and withdraw access without exposing organization credentials.
- **Developer:** Integrate the runtime or registered app with identity, scoped calls and verifiable events without moving runtime sessions into the kernel.
- **Operator:** Decide the exceptions that need a named human, then inspect the resulting signed history, liveness and cost.
- **End user/consumer:** Choose the identity you are acting as, authorize the apps and disclosures you want, and use the resulting services.
- **Agent (machine):** Prove your own identity, discover your current authority, execute only granted capabilities and publish the signed boundary evidence.

Platforms and agencies running agents for many clients are the ruled secondary audience: their job spans org admin and developer, with **a separate principal/grant/cost context per client**, not a seventh identity class or a shared personal session.
These sentences feed summary-first page design in #3347; each page should show its audience's one main job and needs-action summary before collapsed detail.

## Capability tables

Each audience is collapsed by default. Columns show one entry point and one code/test pair; the YAML is authoritative for the complete entry/evidence lists and grade rationale.
The table projection is checked against YAML by the validator test so grades cannot drift between artifacts.

<!-- capability-tables:start -->
<details>
<summary>business buyer (3)</summary>

| Capability | What you can do | Service; entry | Maturity / weight | Pillar(s) | Code · test |
| --- | --- | --- | --- | --- | --- |
| `signed-record` — Inspect who acted on whose authority | Read personal or acting-org signed events with exact grant and approval references. | jin; `/jin` | live / core | agent identity; delegated authority; signed record and settlement | [record-events.ts](../../apps/kernel/src/lib/jin/record-events.ts) · [record-spec.test.ts](../../apps/kernel/app/jin/api/events/__tests__/record-spec.test.ts) |
| `usage-reconcile` — Compare incurred and billed cost | Inspect per-identity incurred usage, counterparty bills, drift and signed rollups. | usage, jin; `/jin` | partial / core | signed record and settlement | [summary.ts](../../apps/kernel/src/lib/usage/summary.ts) · [spend-shared.test.ts](../../apps/kernel/src/lib/jin/__tests__/spend-shared.test.ts) |
| `buyer-front-door` — Understand Imajin and request access | Read project and developer material and submit the existing contact subscription form. | kernel; `/` | partial / supporting | none | [page.tsx](../../apps/kernel/app/page.tsx) · [LandingGrid.test.tsx](../../apps/kernel/src/components/www/__tests__/LandingGrid.test.tsx) |

</details>

<details>
<summary>org admin (16)</summary>

| Capability | What you can do | Service; entry | Maturity / weight | Pillar(s) | Code · test |
| --- | --- | --- | --- | --- | --- |
| `agent-provision` — Give each agent its own identity | Create or adopt an agent DID for a personal or organization principal. | auth; `/auth/agents` | live / core | agent identity; delegated authority | [agent-provisioner.ts](../../apps/kernel/src/lib/auth/agent-provisioner.ts) · [agent-provisioner.test.ts](../../apps/kernel/src/lib/auth/__tests__/agent-provisioner.test.ts) |
| `delegation-grants` — Grant, renew and revoke authority | Give one agent bounded capabilities, audience and expiry without sharing the principal identity. | auth; `/jin` | works / core | delegated authority; signed record and settlement | [grants.ts](../../apps/kernel/src/lib/auth/grants.ts) · [delegation-grant.test.ts](../../packages/auth/tests/delegation-grant.test.ts) |
| `org-members` — Manage organization authority | Create a group, scope human controllers, suspend member services and transfer ownership. | auth; `/auth/groups` | live / core | delegated authority | [group-member-services.ts](../../apps/kernel/src/lib/auth/group-member-services.ts) · [member-edit.integration.test.ts](../../apps/kernel/src/lib/auth/__tests__/member-edit.integration.test.ts) |
| `org-held-keys` — Seal organization provider keys | Load a shared provider credential once and grant or withdraw member use without reading the key back. | connections; `/auth/connectors` | partial / core | delegated authority | [org-held-connection.ts](../../apps/kernel/src/lib/kernel/org-held-connection.ts) · [org-held-inference.integration.test.ts](../../apps/kernel/src/lib/inference/__tests__/org-held-inference.integration.test.ts) |
| `connector-slots` — Connect an account in a named slot | Keep credentials and consent isolated across multiple connections to the same provider. | connections; `/auth/connectors` | live / supporting | delegated authority | [connection-slots.ts](../../apps/kernel/src/lib/kernel/connection-slots.ts) · [connector-signed-slots.test.ts](../../apps/kernel/src/lib/kernel/__tests__/connector-signed-slots.test.ts) |
| `google-workspace` — Read a connected Google workspace | Connect Google and read Gmail, Calendar, Drive, Meet, Search Console and Business Profile within granted scopes. | google; `/auth/connectors/google` | works / supporting | delegated authority | [connector.ts](../../apps/kernel/src/lib/google/connector.ts) · [connector.test.ts](../../apps/kernel/src/lib/google/__tests__/connector.test.ts) |
| `quickbooks-connector` — Connect accounting access | Authorize a QuickBooks realm in an owner-bound connection with explicit scope consent. | quickbooks; `/auth/connectors/quickbooks` | works / supporting | delegated authority | [connector.ts](../../apps/kernel/src/lib/quickbooks/connector.ts) · [connector.test.ts](../../apps/kernel/src/lib/quickbooks/__tests__/connector.test.ts) |
| `domain-mail` — Send as a verified organization domain | Prove domain ownership, provision Postal sending and choose purpose-specific sender addresses. | auth, jin; `/jin/org-settings` | works / supporting | agent identity; delegated authority | [service.ts](../../apps/kernel/src/lib/domains/service.ts) · [service.test.ts](../../apps/kernel/src/lib/domains/__tests__/service.test.ts) |
| `channel-speaker` — Bind a channel speaker to a principal | Approve a channel link and admit an organization bot speaker only when current membership allows it. | auth; `/auth/channel-link/[token]` | works / core | agent identity; delegated authority | [channel-speaker.ts](../../apps/kernel/src/lib/auth/channel-speaker.ts) · [channel-speaker.integration.test.ts](../../apps/kernel/src/lib/auth/__tests__/channel-speaker.integration.test.ts) |
| `signed-documents` — Sign and verify a document | Create, review, countersign, decline or amend a hash-bound document as the effective identity. | auth; `/auth/attestations` | live / core | agent identity; delegated authority; signed record and settlement | [document-signatures.ts](../../apps/kernel/src/lib/auth/document-signatures.ts) · [org-agreement.integration.test.ts](../../apps/kernel/src/lib/auth/__tests__/org-agreement.integration.test.ts) |
| `payment-requests` — Issue and pay a money request | Issue a request, share an opaque pay link, select an authorized payer and record settlement. | pay; `/auth/money` | live / core | delegated authority; signed record and settlement | [service.ts](../../apps/kernel/src/lib/pay/payment-requests/service.ts) · [payer-did-integration.test.ts](../../apps/kernel/src/lib/pay/payment-requests/__tests__/payer-did-integration.test.ts) |
| `sealed-bank-details` — Seal bank details for an identity | Write or revoke a bank-details record and inspect masked metadata without exposing secret fields. | auth, vault; `/auth/api/bank-details` | partial / core | delegated authority; signed record and settlement | [bank-details.ts](../../apps/kernel/src/lib/vault/bank-details.ts) · [bank-details.integration.test.ts](../../apps/kernel/src/lib/vault/__tests__/bank-details.integration.test.ts) |
| `legal-entity-tax` — Manage organization billing identity | Seal legal-entity details and manage tax registrations for an acting organization. | profile; `/auth/legal-entity` | partial / supporting | agent identity; delegated authority | [legal-entity.ts](../../apps/kernel/src/lib/profile/legal-entity.ts) · [legal-entity.test.ts](../../apps/kernel/src/lib/profile/__tests__/legal-entity.test.ts) |
| `provider-credentials` — Connect a model provider | Seal provider keys, select models and grant inference for Anthropic, OpenAI, Gemini, xAI, Moonshot, Z.ai, OpenRouter or local inference. | anthropic, openai, gemini, xai, moonshot, zai, openrouter, local; `/auth/connectors` | works / supporting | delegated authority | [connector-registry.ts](../../apps/kernel/src/lib/kernel/connector-registry.ts) · [connector-oauth-split-config.test.ts](../../apps/kernel/src/lib/kernel/__tests__/connector-oauth-split-config.test.ts) |
| `stripe-connector` — Connect an owner payment rail | Seal seller Stripe credentials and verify checkout or webhook events against that owner connection. | stripe, pay; `/auth/connectors/stripe` | works / supporting | delegated authority; signed record and settlement | [connector.ts](../../apps/kernel/src/lib/stripe/connector.ts) · [connector.test.ts](../../apps/kernel/src/lib/stripe/__tests__/connector.test.ts) |
| `gcp-credential` — Configure a Google Cloud connection | Load a scoped Google Cloud connection through the shared credential and scope-manifest contract. | gcp; `/auth/connectors/gcp` | partial / supporting | delegated authority | [connector-registry.ts](../../apps/kernel/src/lib/kernel/connector-registry.ts) · [scope-manifest-route.test.ts](../../apps/kernel/src/lib/kernel/__tests__/scope-manifest-route.test.ts) |

</details>

<details>
<summary>developer (20)</summary>

| Capability | What you can do | Service; entry | Maturity / weight | Pillar(s) | Code · test |
| --- | --- | --- | --- | --- | --- |
| `github-connector` — Delegate GitHub repository work | Connect a GitHub account, read repository/PR data and request approval for protected operations. | github; `/auth/connectors/github` | works / supporting | delegated authority | [connector.ts](../../apps/kernel/src/lib/github/connector.ts) · [connector.test.ts](../../apps/kernel/src/lib/github/__tests__/connector.test.ts) |
| `app-registration` — Register an identity-owned app | Register, update or revoke an app and publish safe presentation declarations under the acting owner. | registry; `/auth/developer/apps` | live / core | agent identity; delegated authority | [app-registry.ts](../../apps/kernel/src/lib/kernel/app-registry.ts) · [registry-app-expiry-spec.test.ts](../../apps/kernel/src/lib/kernel/__tests__/registry-app-expiry-spec.test.ts) |
| `upstream-connections` — Call a reviewed app upstream | Seal a personal key for a declared app destination and call it with kernel credential injection. | connections; `/connections/api/upstreams` | works / core | delegated authority | [app-upstream.ts](../../apps/kernel/src/lib/kernel/app-upstream.ts) · [external-mcp.integration.test.ts](../../apps/kernel/src/lib/kernel/__tests__/external-mcp.integration.test.ts) |
| `attestations` — Issue and revoke signed claims | Discover types, issue a claim, countersign it or revoke it while retaining history. | auth; `/auth/attestations` | live / core | agent identity; delegated authority; signed record and settlement | [emit-mechanical-attestation.ts](../../apps/kernel/src/lib/auth/emit-mechanical-attestation.ts) · [attestation-types.test.ts](../../packages/auth/tests/attestation-types.test.ts) |
| `turn-evidence` — Verify a recorded tool turn | Ingest signed tool-call evidence and publicly verify a turn claim against its hash. | auth; `/auth/api/attestations/turn-evidence` | works / core | signed record and settlement | [authorize-publisher.ts](../../apps/kernel/src/lib/turn-evidence/authorize-publisher.ts) · [turn-evidence.test.ts](../../packages/auth/tests/turn-evidence.test.ts) |
| `identity-keys` — Authenticate and rotate identity keys | Prove a DID with a signed challenge, resolve its chain and rotate current keys. | auth; `/auth/login` | works / core | agent identity | [crypto.ts](../../apps/kernel/src/lib/auth/crypto.ts) · [key-rotation.test.ts](../../packages/auth/tests/key-rotation.test.ts) |
| `payments-settlement` — Collect and settle an app payment | Create hosted checkout, settle an app-owned payment, refund it and retain payment attribution. | pay; `/pay` | works / core | signed record and settlement | [hosted-checkout.ts](../../apps/kernel/src/lib/pay/hosted-checkout.ts) · [settlement-invariants.test.ts](../../apps/kernel/src/lib/pay/__tests__/settlement-invariants.test.ts) |
| `fair-attribution` — Verify attribution and payment shares | Build and verify a signed .fair manifest with contributor shares and settlement receipts. | media, pay; `/media` | works / core | signed record and settlement | [index.ts](../../packages/fair/src/index.ts) · [crypto-invariants.test.ts](../../packages/fair/tests/crypto-invariants.test.ts) |
| `registry-relay` — Discover nodes and relay signed chains | Register and heartbeat nodes, resolve DIDs and serve DFOS identity/content relay traffic. | registry; `/registry` | partial / core | agent identity; signed record and settlement | [postgres-store.ts](../../apps/kernel/src/lib/registry/relay/postgres-store.ts) · [dfos-relay.test.ts](../../apps/kernel/src/lib/auth/__tests__/dfos-relay.test.ts) |
| `corpus-retrieval` — Search a DID-owned corpus | Ingest GitHub or local workspace sources, pin refs, search and fetch ingestion attestations. | corpus; `/auth/corpus` | works / supporting | delegated authority; signed record and settlement | [routes.ts](../../apps/corpus/src/routes.ts) · [routes.owner.test.ts](../../apps/corpus/src/__tests__/routes.owner.test.ts) |
| `event-projections` — Project signed events and settlement | Publish attested events and run declarative chain reactions for notifications, audit, usage and settlement. | shared; `@imajin/bus` | works / supporting | signed record and settlement | [index.ts](../../packages/bus/src/index.ts) · [publish-chain-log.test.ts](../../packages/bus/tests/publish-chain-log.test.ts) |
| `runtime-envelope` — Bootstrap a runtime identity | Render an identity-bound runtime envelope and provision a selected agent harness. | shared; `@imajin/claw-envelope` | works / supporting | agent identity; delegated authority | [index.ts](../../packages/claw-envelope/src/index.ts) · [bootstrap-identity.test.ts](../../packages/claw-envelope/tests/bootstrap-identity.test.ts) |
| `nanoclaw-channel` — Connect a NanoClaw channel | Authenticate and dispatch messages through a scoped channel and emit mapped usage. | shared; `@imajin/nanoclaw-imajin-channel` | works / supporting | agent identity; delegated authority; signed record and settlement | [index.ts](../../packages/nanoclaw-imajin-channel/src/index.ts) · [channel-adapter.test.ts](../../packages/nanoclaw-imajin-channel/tests/channel-adapter.test.ts) |
| `claude-usage-emitter` — Emit signed Claude Code usage | Tail local session usage, map it and send identity-bound incurred events. | shared; `@imajin/usage-emitter-claude-code` | partial / core | signed record and settlement | [index.ts](../../packages/usage-emitter-claude-code/src/index.ts) · [mapper.test.ts](../../packages/usage-emitter-claude-code/tests/mapper.test.ts) |
| `reflex-guard` — Gate an outbound agent response | Match guard rules, stamp responses and retain audit output before outbound delivery. | shared; `@imajin/openclaw-reflex-guard` | works / supporting | delegated authority; signed record and settlement | [outbound-guard-hooks.ts](../../packages/openclaw-reflex-guard/src/outbound-guard-hooks.ts) · [outbound-guard-hooks.test.ts](../../packages/openclaw-reflex-guard/tests/outbound-guard-hooks.test.ts) |
| `shared-ui` — Integrate identity-aware app controls | Compose navigation, identity switching, notifications and shared controls in an app. | shared; `@imajin/ui` | works / supporting | agent identity | [index.ts](../../packages/ui/src/index.ts) · [index.test.ts](../../packages/ui/tests/index.test.ts) |
| `money-math` — Calculate exact amounts and FX | Convert decimal monetary amounts and apply cached FX rates without floating-point share drift. | shared; `@imajin/money` | works / supporting | signed record and settlement | [index.ts](../../packages/money/src/index.ts) · [fx-snapshot.test.ts](../../packages/money/tests/fx-snapshot.test.ts) |
| `shared-infrastructure` — Build on common operational primitives | Configure service URLs, run bounded DB clients, record logs and apply workspace lint conventions. | shared; `@imajin/config` | works / supporting | none | [index.ts](../../packages/config/src/index.ts) · [services.test.ts](../../packages/config/tests/services.test.ts) |
| `typesafe-evaluation` — Call a configured typed evaluator | Connect a TypeSafe endpoint and submit evaluation requests through the client. | typesafe; `/auth/connectors/typesafe` | partial / supporting | none | [client.ts](../../apps/kernel/src/lib/typesafe/client.ts) · [client.test.ts](../../apps/kernel/src/lib/typesafe/__tests__/client.test.ts) |
| `contact-disclosure` — Release contact data through consent | Request contact fields through the broker and manage grants without granting unrestricted profile access. | broker; `/broker/api/contacts` | works / core | delegated authority; signed record and settlement | [contact-disclosures.ts](../../apps/kernel/src/lib/broker/routes/contact-disclosures.ts) · [broker.test.ts](../../packages/bus/tests/broker.test.ts) |

</details>

<details>
<summary>operator (10)</summary>

| Capability | What you can do | Service; entry | Maturity / weight | Pillar(s) | Code · test |
| --- | --- | --- | --- | --- | --- |
| `operator-approvals` — Approve risky actions | Approve, deny or withdraw an addressed proposal and retain the signed decision and execution outcome. | jin, notify; `/jin` | live / core | delegated authority; signed record and settlement | [operator-approvals-service.ts](../../apps/kernel/src/lib/notify/operator-approvals-service.ts) · [operator-approvals-service.test.ts](../../apps/kernel/src/lib/notify/__tests__/operator-approvals-service.test.ts) |
| `billed-receipts` — Record a counterparty bill | Confirm extracted receipt lines or backfill a manual billed statement with signed provenance. | usage; `/usage/api/billed` | works / core | signed record and settlement | [manual.ts](../../apps/kernel/src/lib/usage/billed/manual.ts) · [receipt-extract.test.ts](../../apps/kernel/src/lib/usage/billed/__tests__/receipt-extract.test.ts) |
| `vault-mint-import` — Custody and rotate service credentials | Mint a service key or import a static secret through an explicit operator proposal. | vault; `/jin` | live / core | agent identity; delegated authority; signed record and settlement | [mint.ts](../../apps/kernel/src/lib/vault/mint.ts) · [mint.test.ts](../../apps/kernel/src/lib/vault/__tests__/mint.test.ts) |
| `ssh-certificates` — Delegate short-lived SSH access | Mint and rotate a custodied CA and issue constrained throwaway user certificates under grants. | vault; `/jin` | works / core | delegated authority; signed record and settlement | [ssh-ca.ts](../../apps/kernel/src/lib/vault/ssh-ca.ts) · [ssh-ca.integration.test.ts](../../apps/kernel/src/lib/vault/__tests__/ssh-ca.integration.test.ts) |
| `cloudflare-operations` — Delegate zone operations | Preview or approve DNS, proxy and cache mutations and inspect signed zone history. | cloudflare; `/jin` | live / supporting | delegated authority; signed record and settlement | [routes.ts](../../apps/kernel/src/lib/cloudflare/routes.ts) · [delegation-acceptance.integration.test.ts](../../apps/kernel/src/lib/cloudflare/__tests__/delegation-acceptance.integration.test.ts) |
| `app-provisioning` — Provision and claim a registered app | Request operator-approved app setup, service scopes and a one-time signing-key claim. | jin; `/jin` | live / supporting | agent identity; delegated authority | [provision.ts](../../apps/kernel/src/lib/apps/provision.ts) · [provision.test.ts](../../apps/kernel/src/lib/apps/__tests__/provision.test.ts) |
| `signed-loops` — Follow a signed agent run | Publish lifecycle and horizon observations and reconcile receipts without reading runtime transcripts. | jin; `/jin` | live / core | agent identity; signed record and settlement | [cycle.ts](../../apps/kernel/src/lib/loops/cycle.ts) · [horizon-binding.test.ts](../../apps/kernel/src/lib/loops/__tests__/horizon-binding.test.ts) |
| `runtime-commands` — Authorize a command to a connected run | Prepare or dispatch a principal-signed command over the authenticated runtime session binding. | jin; `/jin` | works / core | delegated authority; signed record and settlement | [session-commands.ts](../../apps/kernel/src/lib/jin/session-commands.ts) · [session-commands.test.ts](../../apps/kernel/src/lib/jin/__tests__/session-commands.test.ts) |
| `cycle-preview` — Preview a sprint cycle | Start a scoped cycle rail and emit decision previews; phases currently record skipped, not work performed. | jin, mcp; `/jin` | partial / supporting | delegated authority; signed record and settlement | [cycle.ts](../../apps/kernel/src/lib/mcp/tools/cycle.ts) · [cycle-tools.test.ts](../../apps/kernel/src/lib/mcp/__tests__/cycle-tools.test.ts) |
| `node-operations` — Inspect node health and history | Inspect service liveness, administrative event traces, logs, storage and reconciliation views. | kernel, registry; `/admin` | works / supporting | none | [ops-liveness.ts](../../apps/kernel/src/lib/jin/ops-liveness.ts) · [health-route.test.ts](../../packages/db/tests/health-route.test.ts) |

</details>

<details>
<summary>end user/consumer (13)</summary>

| Capability | What you can do | Service; entry | Maturity / weight | Pillar(s) | Code · test |
| --- | --- | --- | --- | --- | --- |
| `app-consent` — Authorize an app without sharing a login | Consent to scoped app access and exchange single-use codes for audience-bound tokens. | auth; `/auth/authorize` | live / core | agent identity; delegated authority | [app-authorization-code.ts](../../apps/kernel/src/lib/auth/app-authorization-code.ts) · [callback-exchange.test.ts](../../packages/auth-client/tests/callback-exchange.test.ts) |
| `app-directory` — Choose apps for your identity | Browse discoverable registered apps and add them to identity-scoped navigation. | auth, registry; `/auth/app-directory` | live / supporting | delegated authority | [app-nav.ts](../../apps/kernel/src/lib/kernel/app-nav.ts) · [operational-apps.test.ts](../../apps/kernel/src/lib/kernel/__tests__/operational-apps.test.ts) |
| `onboarding-security` — Sign in and protect an account | Verify email, claim a soft session and manage devices, MFA and recovery codes. | auth; `/auth/onboard` | live / supporting | agent identity | [onboard.ts](../../apps/kernel/src/lib/auth/onboard.ts) · [onboard.test.ts](../../apps/kernel/src/lib/auth/__tests__/onboard.test.ts) |
| `wallet` — Manage identity balances | Read balances and transactions, top up, transfer or gift credit to another DID. | pay; `/pay` | works / supporting | signed record and settlement | [ledger.ts](../../apps/kernel/src/lib/pay/ledger.ts) · [app-money-routes.test.ts](../../apps/kernel/src/lib/pay/__tests__/app-money-routes.test.ts) |
| `media-assets` — Store and share attributed files | Upload, find, rename, transfer and grant access to identity-owned media with .fair manifests. | media; `/media` | works / supporting | delegated authority; signed record and settlement | [create-asset.ts](../../apps/kernel/src/lib/media/create-asset.ts) · [assets-upload-route.test.ts](../../apps/kernel/src/lib/media/__tests__/assets-upload-route.test.ts) |
| `articles` — Publish an attributed article | Publish and read articles backed by the media control-document and .fair machinery. | media; `/articles` | works / side-effect | signed record and settlement | [article-core.ts](../../apps/kernel/src/lib/media/article-core.ts) · [article-route.test.ts](../../apps/kernel/src/lib/media/__tests__/article-route.test.ts) |
| `chat` — Message a trusted connection or group | Send, edit, react to and read DID-keyed messages and shared media under conversation access checks. | chat; `/chat` | works / side-effect | none | [message-helpers.ts](../../apps/kernel/src/lib/chat/message-helpers.ts) · [send-message-dm-guard.test.ts](../../apps/kernel/src/lib/chat/__tests__/send-message-dm-guard.test.ts) |
| `connections-pods` — Build a private connection graph | Invite a person, label a bilateral connection and manage scoped group pods. | connections; `/connections` | works / supporting | delegated authority | [payment-request-invite.ts](../../apps/kernel/src/lib/connections/payment-request-invite.ts) · [direct-invites.test.ts](../../apps/kernel/src/lib/connections/__tests__/direct-invites.test.ts) |
| `profile-presence` — Present an identity and its agent presence | Edit public identity metadata, claim a handle and query an authorized presence. | profile; `/profile` | works / supporting | agent identity; delegated authority | [index.ts](../../apps/kernel/src/lib/profile/index.ts) · [presence-query-settle.test.ts](../../apps/kernel/src/lib/profile/__tests__/presence-query-settle.test.ts) |
| `notifications` — Receive an identity-scoped notification | Read notifications, mark them read and choose delivery preferences. | notify; `/notify` | works / supporting | none | [delivery.ts](../../apps/kernel/src/lib/notify/delivery.ts) · [ws-push.test.ts](../../apps/kernel/src/lib/notify/__tests__/ws-push.test.ts) |
| `calendar-intents` — Declare availability without disclosing it | Set or cancel an availability intent and manage calendar entries under the broker gate. | calendar; `/calendar/api/availability` | works / side-effect | delegated authority | [index.ts](../../apps/kernel/src/lib/calendar/index.ts) · [route.test.ts](../../apps/kernel/app/calendar/api/spec/__tests__/route.test.ts) |
| `extracted-app-boundary` — Use an added external community app | Discover an added events, market or learning app and authorize it through kernel primitives. | events, market, learn; `/auth/app-directory` | works / side-effect | none | [app-nav.ts](../../apps/kernel/src/lib/kernel/app-nav.ts) · [operational-apps.test.ts](../../apps/kernel/src/lib/kernel/__tests__/operational-apps.test.ts) |
| `broker-agent` — Coordinate sealed social intentions | Use a Telegram broker to set, list and cancel your own availability intentions. | broker-agent, calendar; `Telegram broker tools (not HTTP)` | partial / side-effect | delegated authority | [tools.ts](../../apps/broker-agent/src/tools.ts) · [agent.test.ts](../../apps/broker-agent/src/__tests__/agent.test.ts) |

</details>

<details>
<summary>agent (machine) (11)</summary>

| Capability | What you can do | Service; entry | Maturity / weight | Pillar(s) | Code · test |
| --- | --- | --- | --- | --- | --- |
| `inference-passthrough` — Use a sealed inference connection | Run a completion as an agent under principal-owned credentials with bounded inference scopes. | infer; `/infer/v1/chat/completions` | partial / core | agent identity; delegated authority; signed record and settlement | [resolve.ts](../../apps/kernel/src/lib/inference/resolve.ts) · [assigned-org-bot.integration.test.ts](../../apps/kernel/src/lib/inference/__tests__/assigned-org-bot.integration.test.ts) |
| `agent-self-discovery` — Discover your identity and authority | Ask as the signing agent which principal, connectors and models are actually usable. | infer; `/infer/v1/self` | works / core | agent identity; delegated authority | [self-discovery.ts](../../apps/kernel/src/lib/inference/self-discovery.ts) · [self-discovery-connectors.test.ts](../../apps/kernel/src/lib/inference/__tests__/self-discovery-connectors.test.ts) |
| `vault-delegation` — Deliver a recipient-bound secret grant | Discover, fetch and acknowledge credentials already delegated to the intended recipient. | vault; `/api/vault/delegation/grants` | works / core | delegated authority; signed record and settlement | [grant.ts](../../apps/kernel/src/lib/vault/grant.ts) · [delegation.test.ts](../../packages/vault-core/tests/delegation.test.ts) |
| `postman-mcp` — Use a delegated external MCP connection | Seal a personal Postman key and call allowlisted read-only tools through the kernel. | connections; `/auth/connectors` | works / supporting | delegated authority | [external-mcp.ts](../../apps/kernel/src/lib/kernel/external-mcp.ts) · [external-mcp.integration.test.ts](../../apps/kernel/src/lib/kernel/__tests__/external-mcp.integration.test.ts) |
| `mcp-tools` — Call scoped kernel tools | Use the registered MCP tools for discovery, messages, media, connections and delegated integrations. | mcp; `/mcp` | works / core | agent identity; delegated authority | [index.ts](../../apps/kernel/src/lib/mcp/tools/index.ts) · [agent-gateway.integration.test.ts](../../apps/kernel/src/lib/mcp/__tests__/agent-gateway.integration.test.ts) |
| `reach` — Reach a person through their agent | Discover a public reach card, submit a gated message and read the principal-signed reply receipt. | auth, jin; `/[handle]/reach` | works / supporting | agent identity; delegated authority; signed record and settlement | [agent-reach.ts](../../apps/kernel/src/lib/auth/agent-reach.ts) · [reach-authority.integration.test.ts](../../apps/kernel/src/lib/auth/__tests__/reach-authority.integration.test.ts) |
| `warp-dispatch` — Dispatch a delegated cloud task | Launch and watch a Warp task under a sealed connection and record its signed loop observations. | warp; `/mcp` | works / supporting | delegated authority; signed record and settlement | [dispatch.ts](../../apps/kernel/src/lib/warp/dispatch.ts) · [dispatch.test.ts](../../apps/kernel/src/lib/warp/__tests__/dispatch.test.ts) |
| `media-transcription` — Transcribe an audio asset | Create a transcript from owned audio/video and read it through the existing media access rules. | media; `/media` | works / supporting | none | [transcribe-asset.ts](../../apps/kernel/src/lib/media/transcribe-asset.ts) · [transcribe-asset.test.ts](../../apps/kernel/src/lib/media/__tests__/transcribe-asset.test.ts) |
| `discord-messages` — Read and post Discord messages | Seal a bot token and read channels or post messages within explicitly granted Discord scopes. | discord; `/auth/connectors/discord` | works / supporting | delegated authority | [connector.ts](../../apps/kernel/src/lib/discord/connector.ts) · [connector.test.ts](../../apps/kernel/src/lib/discord/__tests__/connector.test.ts) |
| `buzz-nostr` — Publish a signed Nostr message | Generate a sealed Nostr keypair, inspect its public key and send a relay-confirmed group event. | buzz; `/mcp` | works / side-effect | agent identity; signed record and settlement | [connector.ts](../../apps/kernel/src/lib/buzz/connector.ts) · [connector.test.ts](../../apps/kernel/src/lib/buzz/__tests__/connector.test.ts) |
| `agent-messages` — Message on a principal grant | Read the principal conversations or send a message through explicit messages scopes. | chat, mcp; `/mcp` | works / supporting | delegated authority | [messages.ts](../../apps/kernel/src/lib/mcp/tools/messages.ts) · [messages.test.ts](../../apps/kernel/src/lib/mcp/__tests__/messages.test.ts) |

</details>
<!-- capability-tables:end -->

## Navigation proposal

**Proposal only for #3370; this PR changes no navigation.** Six signed-in top-level groups, ordered by audience × business weight:

1. **Agents & identity** — org admin/developer, core. Current `/auth/agents`, `/auth/groups`, `/auth/members`, `/auth/security`, `/profile/keys`; preserve personal/acting-org context. Put agent self-discovery alongside the agent, not under generic profile marketing.
2. **Authority & connections** — org admin, core/supporting. Current `/auth/connectors`, `/auth/connectors/[id]`, `/jin/org-settings`, `/auth/authorize`, `/auth/apps`, and `/jin` Grants/Front door. Group provider setup, named slots and grant/revoke without conflating membership with delegation.
3. **Inbox & decisions** — operator, core. Current `/jin` approvals/DecisionCards/Reach, `/auth/notifications`, `/notify`. Needs-action first; collapse healthy state, preserve explicitly addressed personal and org inboxes.
4. **Record & spend** — buyer/operator, core. Current `/jin` Record/Runs/Spend, `/auth/attestations`, `/auth/documents/[id]`, `/auth/money`, `/pay/history`, `/pay/r/[handle]`, `/auth/legal-entity`, `/auth/tax`. Keep incurred vs billed vs settlement distinct; do not imply all costs are captured.
5. **Build & operate** — developer/operator, core/supporting. Current `/auth/developer/apps`, `/auth/corpus`, `/developer-guide`, `/registry`, `/health`, `/admin/*`. Link API/spec discovery and SDKs here. Hide operator-only controls from ordinary users; do not move authorization enforcement into nav.
6. **Your apps & files** — end user, supporting/side-effect. Current `/auth/app-directory`, `/auth/[app]`, `/media`, `/articles`, `/chat`, `/connections`, `/profile`. Added events/market/learn/coffee/links/dykil placements stay registry-driven, never a static universal entitlement.

**Anonymous/front-door hierarchy is different:** lead with the three pillars, how it works, compare, and alpha access (book a demo / join the alpha as tester, integrator or partner). Keep `/project` as “Why we built it this way”; no hardware, community-app catalogue or token economics as the category. Existing `/`, `/build`, `/bump`, `/whitepaper`, `/docs`, `/privacy`, `/disclosures` are marketing/reference/legal surfaces, not extra signed-in groups.

<details>
<summary>Current navigation evidence and capabilities with no dedicated home</summary>

- [`IdentityTabBar.tsx`](../../apps/kernel/app/auth/components/IdentityTabBar.tsx) currently exposes Agents, Attestations/Documents, Notifications, Developer, Connected apps, Connections, Money, Tax, Legal entity, Corpus, Security, Settings and Members. Scope gates live in [`auth/layout.tsx`](../../apps/kernel/app/auth/layout.tsx).
- [`app-nav.ts`](../../apps/kernel/src/lib/kernel/app-nav.ts) resolves registry placement, app visibility and per-identity membership/grants. The static [`services.ts`](../../packages/config/src/services.ts) is **infra topology, not nav authority**.
- [`jin-nav-entry.tsx`](../../packages/ui/src/jin-nav-entry.tsx) exposes `/jin`; [`jin/page.tsx`](../../apps/kernel/app/jin/page.tsx) composes its lanes. #3348 tracks summary-first repair; this map is not evidence that repair shipped.
- **No dedicated human page/home:** agent self-discovery and inference API; recipient vault fetch/ack; public turn verification; billed-receipt confirmation; broker contact disclosure; calendar intents; Postman RPC; Warp environment reads; runtime SDKs/emitters. Put contextual API links under Agents, Authority, Record or Build, not new top-level menus.
- **Contextual only:** SSH/Cloudflare/vault actions, command-to-run, reach cards and document detail are embedded or deep-linked; retaining a `/jin` link does not establish a distinct top-level service UI.
- **No product home yet:** hosted agent instance lifecycle (#3113/#3115/#3116/#3119), cycle engine (#2313), general record-verifier landing (#3364), complete bank-transfer workflow (#3074).
- **External boundary:** ticket selling, market transactions, courses and surveys are not graded live from kernel port rows or payment callback tests. Only the integration seam is included; inspect each registered app's repo/spec for its own capabilities.

</details>

## Positioning cut for #3284

**Canonical source at this snapshot:** [the 2026-11-09 ruling](https://github.com/ima-jin/imajin-ai/issues/3284#issuecomment-6753880988). `docs/POSITIONING.md` was absent on main at the start; once #3366 lands, it becomes the copy source. Do not treat this map as new positioning rulings.

- **Category:** the trust layer for AI agents.
- **One line:** identity and authority for AI agents.
- **Sub-line:** your agents act as themselves, on your authority, and every action is signed.
- **Who:** businesses putting AI agents in front of customers or staff where the agent acts for a person; also platforms and agencies running agents for many clients.
- **How it fits:** a plugin for your agent runtime plus the Imajin kernel; OpenClaw today, harness swappable; hosted or self-run. The kernel learns through signed events, not runtime session keys or transcript access.
- **Alpha CTA:** book a demo, or join the alpha as a tester, integrator or partner. Joining the alpha is this version's sign-up path. Do not imply self-serve before #3364.

Ranked proof for the core-weight capabilities (primitive tests ≠ universal end-to-end delivery):

1. **Agent identity:** `agent-provision`, `identity-keys`, `agent-self-discovery`, `channel-speaker`, `app-registration`, `app-consent`, `mcp-tools`. Provisioning, acting-org, crypto/rotation, token and gateway tests provide inspectable proof of distinct identities; a runtime is not the principal.
2. **Delegated authority:** `delegation-grants`, `org-members`, `operator-approvals`, `vault-mint-import`, `vault-delegation`, `ssh-certificates`, `upstream-connections`, `contact-disclosure`. Grant introspection, named approvers, countersignatures and bounded recipient delivery are implemented. `org-held-keys` and `inference-passthrough` remain partial at the complete-workflow level; do not sell provider-wide parity.
3. **Signed record:** `signed-record`, `signed-loops`, `runtime-commands`, `signed-documents`, `attestations`, `turn-evidence`. Source and tests show principal/grant scoping, hash-bound signatures, chain events and receipt reconciliation. Node-witnessed events and a human's own countersignature are not interchangeable.
4. **Settlement and attributable spend:** `payments-settlement`, `payment-requests`, `fair-attribution`, `billed-receipts`; `usage-reconcile`, `sealed-bank-details`, `claude-usage-emitter` are partial. Payment/manifest invariant tests are proof of primitives, not complete coverage of every runtime, provider or rail.
5. **Network proof (qualified):** `registry-relay` is core but partial while 0.55 admission/index/host work remains open. A signed chain primitive does not prove production-wide federation readiness.

<details>
<summary>Operational proof, customer naming and claim limits</summary>

The ruling's proof is **“Imajin on Imajin”**: the operations agent works under its own identity every day, with signed events, approvals and cost recorded per identity. This run did not access production records or reproduce a live customer workflow. The capability rows therefore cite source/tests, not invented usage counters.

The ruling also names **Agentic Travel Co** and **Agricultural Supply Chain Co**, anonymized until agreements are signed. Do not replace them with guessed customer names or claim signed customer agreements.
Artifact is an org-held integration/test scenario with unresolved production walkthrough #3312 and inference #3329; it is **not** a certified reference customer. No Catalyst usage evidence was established in this checkout.

Say alpha plainly. “Every action is signed” is the ruled ambition/copy, not evidence that every legacy mutation, direct-provider completion or local compute job already emits a signed event.
Keep the cost-capture, legacy authority and extracted-app limits beside demonstrations. A warm standby and tested Postgres restore (#3365) must precede the first design-partner pilot.

</details>

## Gaps

Core-weight partial/dormant rows, **listed, not implemented**:

- **`org-held-keys`:** provider-specific organization parity (#3341), canonical custody/model picker (#3343), holder/grant normalization (#3318).
- **`inference-passthrough`:** direct-provider bypass/Artifact completion proof (#3329), signed incurred ingress (#3278), reactor-only projections (#3263), hosted-instance inference (#3118).
- **`usage-reconcile`:** gateway emitter (#3135), Warp/Kimi bills (#3137), emitter health (#3138), local-compute metering (#3139), public capstone (#3142), complete projection chain (#3263).
- **`sealed-bank-details`:** issuer settings (#3076), payer-bound disclosure (#3077), bank-transfer pay-in/reconciliation (#3079); the storage API is not the complete rail.
- **`registry-relay`:** 0.55 admission/write policy (#3307), index (#3308), canonical relay host (#3309); parent #3305.
- **`claude-usage-emitter`:** deployment/registration and real receipt flow (#3140). Built/tested does not mean active.
- **Dormant core rows:** none established by the two-part inactivity + inbound-link test.

Other business-blocking limits: legacy agent membership authority (#3012), grant-path unification (#3334), orphan/degraded approval outcomes (#3019/#3020), unfinished hosted agents (#3113), corpus organization access/layered search (#3100/#3101), broker deployment (#3092) and stub match responses, cycle stub (#2313), incomplete bank legal/PDF experience (#2661/#3072/#3073), warm standby + restore (#3365). These remain outside this docs change.

## Validation and maintenance

Run `node scripts/check-capabilities.mjs` from the repo root. It validates required fields, array types, enum values, IDs, dates, org-scoped issue URLs, safe existing evidence files, live/test prerequisites, every app/package/local spec and the readable table projection.
Negative tests live in [`check-capabilities.test.mjs`](../../scripts/__tests__/check-capabilities.test.mjs).
That file is included by the root Vitest `scripts/__tests__/**/*.test.mjs` pattern and runs in the existing required CI test shards; no new workflow, dependency, product route or UI is needed.

When changing YAML, regenerate only the text between `capability-tables:start` and `capability-tables:end` with the validator module's `renderCapabilityTables(document)` export; retain editorial sections.
Recheck the relevant implementation, tests, navigation and `/spec`; update dates/issues and the snapshot SHA intentionally. Schema validity cannot prove a claim is true, a test passed, a service deployed, or a customer used it.
