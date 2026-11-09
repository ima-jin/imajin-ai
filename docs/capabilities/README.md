# Imajin capability map

Imajin is a B2B SDK and platform for **agent identity and authority**. Start with an
agent's identity, the authority its principal grants, the actions a human must
approve, and the signed record of what happened. Consumer and community outcomes
are side effects, not the business front door.

This map feeds [#3284](https://github.com/ima-jin/imajin-ai/issues/3284) positioning
and [#3347](https://github.com/ima-jin/imajin-ai/issues/3347) page audiences. It
proposes information architecture; it does **not** change navigation, routes,
product code or `DESIGN.md`.

## Scope and evidence

Snapshot: **2026-11-09**, source commit
`d905c286816f975d3ef5ed79564d5c274c4b91bd`. The authoritative records are in
[`capabilities.yaml`](capabilities.yaml): 77 actions, all three current apps
(`kernel`, `corpus`, `broker-agent`), all 102 `page.tsx` files, all served specs,
and all 30 shared packages. A capability is an action someone can take; several
routes often implement one action. The coverage index includes aliases,
redirects and dev-only previews without pretending they are additional products.

Entry points are representative UI paths and main API operations, not an
exhaustive endpoint reference. Read the cited service spec for the complete API.
The vault spec uses absolute `/api/vault/**` paths; other service specs normally
resolve relative to `/{service}`. Corpus is a daemon with its own `/spec`, not a
public app on a new subdomain. Broker-agent has no HTTP spec or human page; its
tool definitions and README are the local contract.

Every grade has a rationale and existing repository paths. `evidence.tests`
identifies relevant tests, **not a claim those tests were run during the audit**.
`last_touched` is the latest non-merge git-log date, commit and changed path among
the capability-specific source and test citations (excluding generic navigation);
it is not a release date or proof of use. Reproduce a date with
`git log -1 --no-merges --format=%cs -- <path>`. Open issue numbers were checked against the
repository's open issue list on the snapshot date; an empty list means no
specific open issue was attached during this audit, not absence of defects.

No live services, production data or secrets were read. No usage numbers,
uptime, customer adoption or production deployment success are inferred.
Artifact-named integration fixtures are code proof, **not a reference-customer
agreement**. Customer names or live-usage claims require separate approved proof.

Events, Market and Learn are **extracted applications**, not directories under
`apps/` at this SHA. The [service manifest](../../packages/config/src/services.ts)
retains port contracts, explicitly not navigation authority; the
[root README](../../README.md) describes the split. Selling tickets, commerce and
courses are recorded in `coverage.external` but not assigned invented local
maturity grades. Payment adapters and callbacks here prove kernel integration,
not the entire extracted app. Coffee, links and survey/legacy app work under
[#1981](https://github.com/ima-jin/imajin-ai/issues/1981) likewise must not be
advertised as complete from old manifest names.

## Grading rubric

### Audience

Use the **primary job owner**, not everyone who could visit a route:
`business buyer`, `org admin`, `developer`, `operator`, `end user/consumer`, or
`agent (machine)`. Secondary users are described in the action and rationale.
Org admin means anyone managing an agent, including a personal principal; it is
not restricted to the node operator.

**`/jin` is an org-admin human approval surface.** Older source comments and
OpenAPI descriptions still call it operator-only. Do not copy that historical
label into page positioning. Individual node-wide keys, provision and Spend
panels may still be operator-gated; the audience label does not widen access.
Personal context and `x-acting-as` organization context are distinct:
[acting-DID tests](../../packages/auth/tests/acting-did.test.ts),
[org Record tests](../../apps/kernel/app/jin/api/events/__tests__/org-record.integration.test.ts)
and [org inference tests](../../apps/kernel/src/lib/inference/__tests__/org-held-inference.integration.test.ts)
are proof of those distinctions, not permission to substitute a session DID.

### Maturity

- **live**: implemented human UI + API + relevant tests + code wiring into
  navigation. This is a code-readiness grade, never a traffic/deployment metric.
- **works**: implemented API or SDK + relevant tests, but thin/no UI or uncertain
  navigation/whole-workflow proof. A read-only documentation surface may be
  inspected directly, but missing behavioral proof is explicitly called out.
- **partial**: stubs, missing pieces, weak direct tests, or an incomplete broader
  promised workflow. Working subpaths do not erase named gaps.
- **dormant**: no relevant commits in 60 days **and** no inbound links. Both
  conditions need explicit history/link evidence. Nothing is graded dormant
  merely because it is old, internal or described as idle.

SDKs have no human page, so a tested library normally tops out at works. A
service having `/spec` is not sufficient proof of functionality. An unrelated
test or package version bump is not proof of the action. If a referenced test
only checks the contract, the rationale states the narrower evidence. No entry
currently satisfies the two-part dormant criterion.

### Business weight

- **core**: identity and authority for agents; scoped delegation/revocation,
  org-held custody, approvals, signed spend/action audit or settlement.
- **supporting**: necessary integration, operations, communications or knowledge
  tools that enable that promise but are not the differentiating front door.
- **side-effect**: consumer/community experiences and project/legacy background.

Weight is strategic relevance to #3284, not measured popularity or revenue.
Maturity and weight are independent: a partial core action is a priority gap,
not a reason to hide it or label it live.

## Per-audience main jobs

- **business buyer:** Decide whether Imajin can give the business's agents
  verifiable identity, bounded authority and inspectable proof, then sign up or
  book a demo.
- **org admin:** Give each agent the right identity, connections and expiring
  authority, approve exceptions and inspect the acting organization's record.
- **developer:** Integrate identity, app tokens, delegation and verifiable
  callbacks using the SDK and discoverable API contracts.
- **operator:** Keep the node, key custody, delivery and accounting infrastructure
  healthy without confusing node-wide powers with a tenant's authority.
- **end user/consumer:** Sign in and control what apps, agents and people may do
  or see on your behalf.
- **agent (machine):** Discover your principal and live authority, execute only
  permitted actions and return signed receipts or evidence.

## Capability table

Grouped by primary audience. IDs join directly to full YAML evidence and
entry points. Dates refer to cited code, not last user activity.

<!-- capability-table:start -->

### business buyer
| Capability | What you can do | Maturity | Weight | Evidence |
| --- | --- | --- | --- | --- |
| `evaluate-platform` — Evaluate agent identity and authority | Understand the platform, read its integration contracts and decide whether to sign up or request a demo. | partial | core | [source](../../apps/kernel/app/page.tsx), [test](../../apps/kernel/app/registry/docs/__tests__/page.s9383.test.tsx); 2026-10-18 |

### org admin
| Capability | What you can do | Maturity | Weight | Evidence |
| --- | --- | --- | --- | --- |
| `manage-org` — Manage an organization identity | Create an organization, assign controllers and members, transfer ownership and switch the acting identity. | live | core | [source](../../apps/kernel/app/auth/members/page.tsx), [test](../../apps/kernel/src/lib/auth/__tests__/org-grants.integration.test.ts); 2026-10-28 |
| `manage-agents` — Create and delegate to agents | Create or adopt an agent, review knocks, provision its identity and inspect its authority. | live | core | [source](../../apps/kernel/app/auth/agents/page.tsx), [test](../../apps/kernel/app/auth/api/agents/__tests__/route.test.ts); 2026-11-05 |
| `delegate-authority` — Grant and withdraw scoped authority | Issue, narrow, renew and revoke an expiring grant without giving an agent blanket account membership. | live | core | [source](../../apps/kernel/app/auth/api/grants/route.ts), [test](../../apps/kernel/app/auth/api/grants/__tests__/route.test.ts); 2026-10-22 |
| `org-held-keys` — Share organization-owned service credentials | Seal an org model or execution key once and grant members use without exposing or copying the key. | partial | core | [source](../../apps/kernel/app/auth/connectors/components/OrgServiceKeys.tsx), [test](../../apps/kernel/src/lib/inference/__tests__/org-held-inference.integration.test.ts); 2026-11-06 |
| `approve-actions` — Approve or reject agent actions | Review a proposal and countersign, reject or withdraw it as its addressed human or organization. | live | core | [source](../../apps/kernel/app/jin/operator-approvals-panel.tsx), [test](../../apps/kernel/app/jin/api/operator-approvals/[proposalId]/decision/__tests__/route-mode-countersign.test.ts); 2026-11-04 |
| `import-secrets` — Import and rotate identity-owned secrets | Propose a sealed credential import or rotation, review its custody and retain signed history when revoking it. | live | core | [source](../../apps/kernel/app/jin/vault-import-panel.tsx), [test](../../apps/kernel/src/lib/vault/__tests__/import-spec.test.ts); 2026-11-04 |
| `mint-service-keys` — Mint and delegate a service signing key | Generate a signing key inside the vault and deliver it once to its intended recipient under a purpose-bound grant. | live | core | [source](../../apps/kernel/app/api/vault/mint/route.ts), [test](../../apps/kernel/app/api/vault/mint/__tests__/route.test.ts); 2026-10-28 |
| `signed-documents` — Request and sign a document | Create a hash-bound agreement, collect signatures as the effective identity, amend or decline it and verify a saved copy. | live | supporting | [source](../../apps/kernel/app/auth/attestations/page.tsx), [test](../../apps/kernel/app/auth/attestations/__tests__/document-page-auth.test.tsx); 2026-11-05 |
| `verify-domains` — Prove organization domain ownership | Bind a domain to an identity using DNS proof and publish verifiable ownership for host routing. | works | supporting | [source](../../apps/kernel/app/auth/settings/page.tsx), [test](../../apps/kernel/src/lib/domains/__tests__/routes.test.ts); 2026-11-04 |
| `org-mail` — Configure organization sending domains | Provision a verified send-only mail domain, check DNS and select fixed-purpose organization or app senders. | works | supporting | [source](../../apps/kernel/app/jin/org-settings/page.tsx), [test](../../apps/kernel/app/jin/api/orgs/[ownerDid]/mail-domains/__tests__/route.test.ts); 2026-11-04 |
| `connector-consent` — Connect services and control their scopes | Choose a named credential connection, authorize selected scopes and disconnect it without revoking other slots. | live | core | [source](../../apps/kernel/app/auth/connectors/page.tsx), [test](../../apps/kernel/src/lib/github/__tests__/scope-manifest.test.ts); 2026-11-06 |
| `track-runs` — Track agent runs and send commands | Inspect signed lifecycle history, lineage, artifacts and spend, then prepare or dispatch a principal-signed command. | live | core | [source](../../apps/kernel/app/jin/runs-panel.tsx), [test](../../apps/kernel/app/jin/__tests__/runs-panel.test.tsx); 2026-11-04 |
| `audit-record` — Inspect a signed action record | Read personal or acting-organization events and trace signed actions back to their actors. | live | core | [source](../../apps/kernel/app/jin/record-panel.tsx), [test](../../apps/kernel/app/jin/api/events/__tests__/org-record.integration.test.ts); 2026-11-02 |
| `account-spend` — Reconcile agent spend and provider bills | Compare incurred and billed cost, attribute it to runs and verify a signed rollup. | partial | core | [source](../../apps/kernel/app/jin/spend-panel.tsx), [test](../../apps/kernel/app/jin/__tests__/spend-panel.test.tsx); 2026-10-28 |
| `brief-retention` — Choose dispatch brief retention | Select how future Warp briefs are retained and record the preference change as a signed event. | works | supporting | [source](../../apps/kernel/app/jin/brief-settings/page.tsx), [test](../../apps/kernel/src/lib/warp/__tests__/brief-ledger.test.ts); 2026-11-04 |
| `app-directory` — Choose apps for an identity workspace | Browse active registered apps and add or remove their navigation placements for the acting identity. | live | supporting | [source](../../apps/kernel/app/auth/app-directory/page.tsx), [test](../../apps/kernel/app/auth/api/apps/[slug]/__tests__/route.test.ts); 2026-10-17 |
| `provision-runtime` — Generate and provision an agent runtime | Render a scoped OpenClaw or NanoClaw envelope and run a provision attempt with retraceable identity and grant references. | live | core | [source](../../apps/kernel/app/auth/agents/page.tsx), [test](../../apps/kernel/app/auth/agents/__tests__/provisioner-ui.test.tsx); 2026-11-05 |
| `request-payment` — Issue and settle a business payment request | Create a tax-aware invoice, share its opaque pay link and settle as an authorized personal or organization payer. | live | core | [source](../../apps/kernel/app/auth/money/page.tsx), [test](../../apps/kernel/app/auth/money/__tests__/page.test.tsx); 2026-10-26 |
| `bank-disclosure` — Seal and revoke payment bank details | Maintain an identity-owned bank document and revoke its disclosure grants while retaining provenance. | works | supporting | [source](../../apps/kernel/api-spec/auth.yaml), [test](../../apps/kernel/src/lib/vault/__tests__/bank-details-spec.test.ts); 2026-11-05 |
| `corpus-search` — Index and search DID-owned knowledge | Load workspace or GitHub sources, sync them and retrieve evidence excerpts from authorized owner partitions. | live | supporting | [source](../../apps/corpus/src/routes.ts), [test](../../apps/corpus/src/__tests__/routes.owner.test.ts); 2026-10-24 |
| `media` — Store and share attributed assets | Upload a file, organize folders, set access, transfer ownership and retrieve its signed attribution manifest. | works | supporting | [source](../../apps/kernel/app/media/page.tsx), [test](../../apps/kernel/src/lib/mcp/__tests__/media-write.test.ts); 2026-10-18 |
| `accounting-connector` — Connect accounting and reconcile invoices | Authorize a QuickBooks realm, invoke permitted invoice operations and reconcile signed payment events. | works | supporting | [source](../../apps/kernel/api-spec/quickbooks.yaml), [test](../../apps/kernel/app/quickbooks/api/invoice/__tests__/route.test.ts); 2026-10-27 |
| `discord-channel` — Connect a Discord bot channel | Seal a Discord bot credential and authorize channel reads or message delivery. | works | supporting | [source](../../apps/kernel/src/lib/kernel/connector-registry.ts), [test](../../apps/kernel/src/lib/mcp/__tests__/messages.test.ts); 2026-10-27 |
| `link-channel-speaker` — Bind a channel speaker to an organization bot | Approve an account link and check the channel sender membership before allowing the organization bot to act. | works | core | [source](../../apps/kernel/api-spec/auth.yaml), [test](../../apps/kernel/src/lib/auth/__tests__/channel-speaker.integration.test.ts); 2026-11-05 |
| `cloudflare` — Delegate verified-zone edge operations | Grant DNS, SSL or cache operations for a verified zone and approve bulk mutations with signed history. | works | supporting | [source](../../apps/kernel/api-spec/cloudflare.yaml), [test](../../apps/kernel/src/lib/cloudflare/__tests__/zone-grants.test.ts); 2026-10-23 |
| `access-bearers` — Issue and revoke a scoped access bearer | Request a surface-scoped bearer, approve its issuance and inspect or revoke your own bearer metadata. | works | core | [source](../../apps/kernel/app/jin/access-bearers-panel.tsx), [test](../../apps/kernel/app/auth/api/access/bearers/__tests__/route.test.ts); 2026-10-07 |

### developer
| Capability | What you can do | Maturity | Weight | Evidence |
| --- | --- | --- | --- | --- |
| `upstream-credentials` — Authorize a destination-bound app API call | Review an app upstream, seal a member-owned key and let the kernel inject it only for that declared destination. | works | core | [source](../../apps/kernel/api-spec/connections.yaml), [test](../../apps/kernel/src/lib/kernel/__tests__/external-mcp.integration.test.ts); 2026-11-06 |
| `verify-turn` — Verify committed agent tool evidence | Ingest signed turn evidence and independently check the tool-call boundary of a claimed agent turn. | works | core | [source](../../packages/auth/src/turn-evidence.ts), [test](../../packages/auth/tests/turn-evidence.test.ts); 2026-11-05 |
| `register-app` — Register an owned developer app | Register or revoke an app, configure its presentation and manage it under the effective personal or organization owner. | live | core | [source](../../apps/kernel/app/auth/developer/apps/page.tsx), [test](../../apps/kernel/app/api/registry/apps/__tests__/route.test.ts); 2026-10-20 |
| `integrate-sdk` — Integrate identity and app bootstrapping | Use SDK helpers for session callbacks, scoped app tokens, signed webhooks and vault-backed service bootstrap. | works | core | [source](../../packages/auth-client/src/index.ts), [test](../../packages/auth-client/tests/vault-boot.test.ts); 2026-11-06 |
| `nanoclaw-channel` — Connect a NanoClaw agent to Imajin chat | Authenticate a channel adapter, receive messages and reconnect while mapping agent usage into the accounting rail. | partial | supporting | [source](../../packages/nanoclaw-imajin-channel/src/index.ts), [test](../../packages/nanoclaw-imajin-channel/tests/channel-adapter.test.ts); 2026-10-07 |
| `guard-agent-output` — Guard and audit outbound agent actions | Apply configured reflex warrants and injection checks to outbound actions and retain a structured audit log. | works | core | [source](../../packages/openclaw-reflex-guard/src/outbound-guard-hooks.ts), [test](../../packages/openclaw-reflex-guard/tests/outbound-guard-hooks.test.ts); 2026-09-01 |
| `issue-attestations` — Issue and verify identity attestations | Sign, countersign, decline or revoke a typed claim and verify its identity chain or witness record. | works | core | [source](../../packages/auth/src/emit-attestation.ts), [test](../../packages/auth/tests/emit-attestation.test.ts); 2026-11-05 |
| `app-checkout` — Collect and settle app payments | Create an app-owned checkout, refund or settle its order and verify signed kernel callbacks. | works | core | [source](../../apps/kernel/api-spec/pay.yaml), [test](../../apps/kernel/src/lib/pay/__tests__/app-money-routes.test.ts); 2026-10-20 |
| `escrow` — Hold and release escrow | Create a hold and release or refund it through the payment API. | works | supporting | [source](../../apps/kernel/app/pay/api/escrow/route.ts), [test](../../apps/kernel/src/lib/pay/__tests__/app-money-routes.test.ts); 2026-10-20 |
| `fair-settlement` — Verify attribution and settlement manifests | Build, sign and verify a .fair manifest and compute its multi-party fees, taxes and settlement distribution. | works | core | [source](../../packages/fair/src/index.ts), [test](../../packages/fair/tests/settlement-invariants.test.ts); 2026-10-14 |
| `money-fx` — Calculate precise money and signed FX | Compute minor-unit amounts, convert currencies using a signed FX snapshot and reject mixed-currency arithmetic. | works | supporting | [source](../../packages/money/src/index.ts), [test](../../packages/money/tests/money.test.ts); 2026-09-09 |
| `notify` — Deliver scoped notifications | Send authorized notifications or interest broadcasts, deliver configured email or push and honor recipient preferences. | works | supporting | [source](../../packages/notify/src/index.ts), [test](../../packages/notify/tests/client.test.ts); 2026-10-22 |
| `calendar` — Manage visibility-scoped calendar entries | Create and update temporal entries and read another identity calendar only through its visibility and broker gate. | works | supporting | [source](../../apps/kernel/app/calendar/api/entries/route.ts), [test](../../apps/kernel/app/calendar/api/spec/__tests__/route.test.ts); 2026-09-09 |
| `emit-local-usage` — Report local coding-agent usage | Tail local coding-agent usage, deduplicate signed accounting input and advance the cursor only after successful delivery. | partial | core | [source](../../packages/usage-emitter-claude-code/src/index.ts), [test](../../packages/usage-emitter-claude-code/tests/index.test.ts); 2026-10-06 |
| `compose-ui` — Embed shared platform controls | Compose identity-aware navigation, chat inputs, media pickers and onboarding gates in an integrating app. | partial | supporting | [source](../../packages/ui/src/index.ts), [test](../../packages/ui/tests/server.test.ts); 2026-10-09 |
| `publish-events` — Publish signed events and react to them | Emit app events and project signed action, usage and settlement records through the event bus. | works | core | [source](../../packages/bus/src/publish-app-event.ts), [test](../../packages/bus/tests/publish-app-event.test.ts); 2026-11-04 |
| `preview-controls` — Inspect development-only control fixtures | Preview agreement, secret, grant, DNS and run controls using development fixtures without treating them as customer journeys. | partial | supporting | [source](../../apps/kernel/app/dev/grants-preview/page.tsx), [test](../../apps/kernel/app/dev/grants-preview/__tests__/preview.test.ts); 2026-10-21 |
| `request-consent` — Request an external principal decision | Raise an expiring app-authenticated consent request and let only its addressed principal approve or reject it. | works | core | [source](../../apps/kernel/app/consent/api/requests/route.ts), [test](../../apps/kernel/app/consent/api/requests/__tests__/route.test.ts); 2026-10-05 |
| `supply-provenance` — Record and trace a supply lot | Publish declared, collected, received, processed or listed stages and inspect the resulting signed lot history. | works | supporting | [source](../../apps/kernel/app/supply/api/declared/route.ts), [test](../../packages/bus/tests/supply-lots.test.ts); 2026-10-05 |
| `register-emitter` — Register a scoped usage emitter | Register an issuer-owned accounting emitter and ingest signed incurred usage without allowing another issuer identity. | works | core | [source](../../apps/kernel/app/usage/api/emitters/route.ts), [test](../../packages/auth/tests/usage-emitter-scopes.test.ts); 2026-10-18 |
| `subscribe-events` — Subscribe to authorized app events | Declare allowed app events, publish them and deliver subscriptions or signed callbacks under scoped app authority. | works | core | [source](../../packages/bus/src/subscriptions.ts), [test](../../packages/bus/tests/event-subscription.test.ts); 2026-10-20 |

### operator
| Capability | What you can do | Maturity | Weight | Evidence |
| --- | --- | --- | --- | --- |
| `ssh-authority` — Delegate short-lived SSH access | Mint a custodied SSH CA, grant signing authority and issue a restricted certificate with overlapping trust during rotation. | works | core | [source](../../apps/kernel/app/api/vault/ssh-ca/route.ts), [test](../../apps/kernel/src/lib/vault/__tests__/ssh-ca-spec.test.ts); 2026-10-27 |
| `federation` — Register and relay verifiable identities | Register a node, resolve identities, publish chain content and relay authorized DFOS operations. | works | supporting | [source](../../apps/kernel/api-spec/registry.yaml), [test](../../apps/kernel/src/lib/registry/relay/__tests__/dfos-write-auth.test.ts); 2026-11-05 |
| `operate-node` — Inspect node health and operational traces | Check services, migrations, storage, logs and correlated request or event traces from the operator console. | live | supporting | [source](../../apps/kernel/app/admin/admin-nav.tsx), [test](../../apps/kernel/app/api/admin/services/health/__tests__/route.test.ts); 2026-10-17 |
| `operate-key-custody` — Operate node key custody and recovery | Inspect node keys and vault state and perform reviewed key rotation or withdrawal reconciliation. | works | core | [source](../../apps/kernel/app/admin/keys/page.tsx), [test](../../apps/kernel/app/admin/keys/__tests__/page.test.tsx); 2026-10-20 |
| `operate-community` — Administer users, moderation and mailing lists | Inspect identity records, moderate flagged content and manage subscribed mailing audiences. | works | side-effect | [source](../../apps/kernel/app/admin/moderation/page.tsx), [test](../../apps/kernel/app/admin/users/[did]/__tests__/page.test.ts); 2026-09-09 |

### end user/consumer
| Capability | What you can do | Maturity | Weight | Evidence |
| --- | --- | --- | --- | --- |
| `create-account` — Create and secure a human account | Register with an invitation, sign in with a key or password, recover access and configure MFA. | partial | supporting | [source](../../apps/kernel/app/auth/register/page.tsx), [test](../../apps/kernel/app/auth/api/recovery-codes/verify/__tests__/route.test.ts); 2026-10-05 |
| `app-consent` — Authorize and revoke an app sign-in | Review app scopes, exchange a single-use sign-in code and revoke an app without confusing navigation membership with authorization. | live | core | [source](../../apps/kernel/app/auth/authorize/page.tsx), [test](../../apps/kernel/app/api/auth/authorize/__tests__/private-consent.test.ts); 2026-11-03 |
| `wallet` — Fund a wallet and inspect its history | View balances, top up by an available rail, transfer credits and inspect transactions. | live | supporting | [source](../../apps/kernel/app/pay/page.tsx), [test](../../apps/kernel/src/lib/pay/__tests__/transfer-withdraw-concurrency.test.ts); 2026-11-05 |
| `chat` — Exchange direct and group messages | Create an authorized conversation, send text or attachments, react, invite participants and track unread messages. | live | supporting | [source](../../apps/kernel/app/chat/conversations/page.tsx), [test](../../apps/kernel/app/chat/api/spec/__tests__/route.test.ts); 2026-10-26 |
| `availability` — Match sealed availability intentions | Set an expiring private intention and receive a match only when independently declared availability overlaps. | partial | side-effect | [source](../../apps/kernel/api-spec/calendar.yaml), [test](../../packages/bus/tests/match-engine-broker.test.ts); 2026-10-14 |
| `broker-agent` — Coordinate intentions in Telegram | Use conversational tools to set, list or cancel your own sealed intentions without exposing another person availability. | partial | side-effect | [source](../../apps/broker-agent/src/tools.ts), [test](../../apps/broker-agent/src/__tests__/agent.test.ts); 2026-10-17 |
| `profile` — Publish an identity profile | Claim a handle and edit a personal or business profile, discover enabled apps and maintain a place stub. | works | supporting | [source](../../apps/kernel/app/profile/edit/page.tsx), [test](../../apps/kernel/app/profile/lib/__tests__/registry-app-links.test.ts); 2026-10-17 |
| `presence` — Query an opt-in AI presence | Ask a permitted identity presence for a streamed or non-streamed answer subject to trust and inference availability. | works | side-effect | [source](../../apps/kernel/api-spec/profile.yaml), [test](../../apps/kernel/src/lib/inference/__tests__/presence-query-usage.test.ts); 2026-11-04 |
| `connections` — Manage bilateral and group relationships | Invite and accept a connection, label an organization relationship, manage a pod and resolve authorized members. | live | supporting | [source](../../apps/kernel/app/connections/page.tsx), [test](../../apps/kernel/src/lib/connections/__tests__/relationship-spec.test.ts); 2026-10-21 |
| `disclosures` — Review and withdraw data disclosures | Inspect broker-mediated disclosures and revoke one or all outstanding consent grants. | works | core | [source](../../apps/kernel/app/disclosures/page.tsx), [test](../../apps/kernel/src/lib/broker/__tests__/revoke-all.test.ts); 2026-07-28 |
| `report-bug` — Report and triage a platform problem | Submit a bug report, view its state and import an authorized report into GitHub. | works | supporting | [source](../../apps/kernel/app/bugs/page.tsx), [test](../../apps/kernel/app/api/bugs/[id]/import/__tests__/route.test.ts); 2026-09-22 |
| `read-project` — Read project background and updates | Read essays, the whitepaper and build log or subscribe to launch updates. | partial | side-effect | [source](../../apps/kernel/app/articles/page.tsx), [implementation](../../apps/kernel/app/articles/page.tsx); 2026-10-17 |

### agent (machine)
| Capability | What you can do | Maturity | Weight | Evidence |
| --- | --- | --- | --- | --- |
| `postman-mcp` — Use a sealed external MCP connection | Seal a personal Postman key and call allowlisted read-only MCP tools through the kernel. | works | supporting | [source](../../apps/kernel/src/lib/kernel/external-mcp.ts), [test](../../apps/kernel/src/lib/kernel/__tests__/external-mcp-transport.test.ts); 2026-11-06 |
| `discover-authority` — Discover an agent identity and usable models | Ask who the signing agent is, which connectors it can use and which sealed models its authority permits. | works | core | [source](../../apps/kernel/app/infer/v1/self/route.ts), [test](../../apps/kernel/src/lib/inference/__tests__/org-held-inference.integration.test.ts); 2026-11-06 |
| `sealed-inference` — Run inference without exporting provider keys | Send model requests under scoped agent authority while the kernel injects the eligible sealed credential and enforces spend caps. | works | core | [source](../../apps/kernel/app/infer/v1/messages/route.ts), [test](../../apps/kernel/src/lib/inference/__tests__/org-held-inference.integration.test.ts); 2026-11-06 |
| `dispatch-agent` — Dispatch and follow cloud agent work | Dispatch an agent using an authorized sealed execution credential, follow its output and cancel or continue its run. | works | core | [source](../../apps/kernel/app/warp/api/dispatch/route.ts), [test](../../apps/kernel/app/warp/api/dispatch/__tests__/route.test.ts); 2026-11-04 |
| `mcp-tools` — Use delegated platform tools through MCP | Authorize an MCP client and invoke only the platform tools allowed by its live scopes and agent binding. | works | core | [source](../../apps/kernel/app/mcp/route.ts), [test](../../apps/kernel/src/lib/mcp/__tests__/scope-gate.test.ts); 2026-11-05 |
| `reach-agent` — Reach an identity through its agent | Discover a public reach card, submit a gated message and retrieve a signed reply or receipt. | works | core | [source](../../apps/kernel/app/[handle]/reach/page.tsx), [test](../../apps/kernel/app/auth/api/agents/[did]/reach/__tests__/delivery.test.ts); 2026-10-18 |
| `corpus-dispatch-context` — Attach authorized corpus context to agent work | Search authorized source-owner partitions and optionally attach bounded evidence to a dispatched agent brief. | partial | supporting | [source](../../apps/kernel/src/lib/warp/corpus-context.ts), [test](../../apps/kernel/src/lib/warp/__tests__/corpus-context.test.ts); 2026-10-27 |
| `transcribe` — Transcribe audio or video | Submit an authorized media asset or upload and obtain text transcription. | works | supporting | [source](../../apps/kernel/app/media/api/transcribe/route.ts), [test](../../apps/kernel/app/media/api/transcribe/__tests__/route.test.ts); 2026-10-07 |
| `github-work` — Read and propose GitHub work | Connect a GitHub OAuth slot, read allowed repositories and stage scoped writes for approval. | works | supporting | [source](../../apps/kernel/src/lib/github/connector.ts), [test](../../apps/kernel/src/lib/mcp/__tests__/github-tools.test.ts); 2026-10-27 |
| `google-work` — Use consented Workspace data and actions | Connect a Workspace slot and use scoped Gmail, Calendar, Drive or Meet tools under sealed refresh-token custody. | works | supporting | [source](../../apps/kernel/api-spec/google.yaml), [test](../../apps/kernel/src/lib/mcp/tools/__tests__/google-tools.test.ts); 2026-11-04 |
| `calibrated-decisions` — Request a typed probabilistic decision | Call a calibrated TypeSafe decision service with a sealed credential and record its metered result. | works | supporting | [source](../../apps/kernel/app/typesafe/api/decide/route.ts), [test](../../apps/kernel/app/typesafe/api/decide/__tests__/route.test.ts); 2026-11-04 |
| `nostr-messages` — Sign and relay attributed Nostr messages | Seal a DID-owned Nostr key and send a signed group message with identity attribution through an authenticated relay. | works | side-effect | [source](../../apps/kernel/src/lib/buzz/connector.ts), [test](../../apps/kernel/src/lib/buzz/__tests__/connector.test.ts); 2026-08-02 |
<!-- capability-table:end -->

## Primary navigation proposal

Six top-level groups, derived from audience × business weight. This is an
authenticated app proposal, **not a route change**. Registry app placements
remain authoritative. Public buyer navigation can use Product / How it works /
Customers / Developers / Company from #3284, with Sign Up and Demo beside it;
do not reuse the operator dashboard as the public landing page.

1. **Agents & authority** — org admin; core. `/auth/agents` (create/adopt,
   provision, grants), `/jin` Inbox/Grants (approve/revoke), agent identity
   discovery. Keep `/jin` reachable at all times as the human approval surface.
   Machine paths `/infer/v1/self`, grant introspection and turn verification are
   documented alongside this group, not clickable human pages.
2. **Organization & connections** — org admin; core/supporting. `/auth`,
   `/auth/groups/new`, `/auth/members`, `/auth/settings`, `/auth/connectors`,
   `/auth/connectors/{id}`, `/auth/channel-link/{token}`, `/jin/org-settings`,
   `/jin/vault/renew`. Group identity, domain proof, org-held keys, OAuth slots
   and senders belong here, with explicit active-identity labels.
3. **Runs, spend & record** — org admin; core. `/jin` Runs/Record/Spend,
   `/auth/money`, `/auth/tax`, `/auth/attestations`, `/auth/documents/{id}`,
   `/auth/legal-entity`, `/pay`, `/pay/history`, `/pay/topup` and `/pay/r/{handle}`.
   Do not imply operator-only Spend views already provide tenant-wide billing.
4. **Workspace** — org admin/end user; supporting/side-effect. `/auth/corpus`,
   `/media`, `/chat/conversations`, `/connections`, `/connections/pods/{id}`,
   `/bump`, `/profile`, `/profile/edit`, `/profile/p/{handle}`,
   `/auth/stubs/new`, `/auth/stubs/{did}`, `/disclosures`, `/auth/apps`,
   `/auth/app-directory`, `/auth/{app}`, `/auth/notifications`, `/notify/settings`,
   `/{handle}/reach`. Installed extracted apps belong here through the registry,
   not unconditional Events/Market/Learn menu links.
5. **Developers** — developer/agent; core/supporting. `/developer-guide`,
   `/docs` → `/registry/docs`, `/auth/developer/apps`,
   `/auth/developer/apps/{appId}`, `/auth/authorize`, API specs, `/mcp`,
   SDK examples. `/dev/*-preview` stays dev-only and outside customer nav.
6. **Node operations** — operator; supporting/core. `/admin` and its
   config/deposits/events/federation/keys/logs/moderation/newsletter/services/
   storage/subscribers/telemetry/users/vault/withdrawals pages, plus `/health`.
   Gate by node authority, not by the mere presence of an acting organization.

Account utilities sit in the identity menu: `/auth/login`, `/auth/onboard`,
`/auth/register`, `/auth/recover`, `/auth/security`, `/profile/keys`; existing
aliases `/profile/login`, `/profile/register`, `/auth/groups`,
`/auth/groups/{groupDid}/settings`, `/auth/settings/security`, `/profile/{handle}`
keep their current redirects/semantics. `/auth/groups/{groupDid}/ownership`
remains an explicit invitation deep-link. `/jin/brief-settings` is a Runs setting.
`/bugs` is Help; `/bugs/admin` is operator triage. `/project`, `/whitepaper`,
`/articles`, `/articles/{handle}/{slug}`, `/build`, `/privacy`, `/subscribe`
and `/register` belong to public Company/account entry paths, not core app groups.
`/chat` and `/notify` are entry/placeholder routes, not extra capabilities.
All concrete current pages, including trace/detail routes, are in YAML coverage.

**No adequate human home today:** API-only external consent requests, supply-lot
provenance, Nostr messaging, SSH certificates, app-upstream
destination authority, external Postman MCP, standalone escrow, calendar entries
and emitter registration/health. Proposed homes: Node operations for SSH;
Organization & connections for upstreams/Postman; Runs, spend & record for escrow
and emitter health; Workspace for calendar and supply traces. External consent
belongs beside approvals; Nostr is an optional integration, not a new core group.
Dispatch and tool execution stay
machine APIs, with human status in Runs. No direct buyer demo or self-service
business onboarding home is proven yet. Do not invent links to close those gaps.

## Positioning cut for #3284

Rank by the identity-and-authority promise, then strength of available proof:

1. **Identity + scoped, revocable authority** (`manage-agents`,
   `delegate-authority`, `discover-authority`, `mcp-tools`): Agents UI,
   [grant route tests](../../apps/kernel/app/auth/api/grants/__tests__/route.test.ts),
   [live introspection tests](../../apps/kernel/app/auth/api/internal/grants/introspect/__tests__/route.test.ts)
   and [agent binding tests](../../apps/kernel/src/lib/mcp/__tests__/agent-binding-authority.test.ts).
   Lead with these implemented boundaries; disclose the legacy membership gap.
2. **Human approval and signed record** (`approve-actions`, `audit-record`,
   `track-runs`, `verify-turn`):
   [decision-mode tests](../../apps/kernel/app/jin/api/operator-approvals/[proposalId]/decision/__tests__/route-mode-countersign.test.ts),
   [org Record integration](../../apps/kernel/app/jin/api/events/__tests__/org-record.integration.test.ts)
   and [turn evidence](../../packages/auth/tests/turn-evidence.test.ts).
   A credible demo is proposal → principal decision → signed record, not an
   unsupported claim that every action already has a complete record.
3. **Organization-owned credentials without key copying** (`org-held-keys`,
   `sealed-inference`, `import-secrets`, `mint-service-keys`):
   [personal/org inference integration](../../apps/kernel/src/lib/inference/__tests__/org-held-inference.integration.test.ts),
   [mint tests](../../apps/kernel/app/api/vault/mint/__tests__/route.test.ts)
   and [recipient-bound fetch](../../apps/kernel/app/api/vault/delegation/grants/[grantId]/fetch/__tests__/app-self-guard.test.ts).
   Fixture names such as Artifact show a modeled scenario, not approved customer
   usage. Provider parity is partial; do not promise “any provider, any agent.”
4. **Developer integration** (`register-app`, `integrate-sdk`,
   `app-checkout`, `fair-settlement`, `publish-events`):
   [vault bootstrap](../../packages/auth-client/tests/vault-boot.test.ts),
   [signed callbacks](../../packages/auth/tests/kernel-webhook.test.ts),
   [settlement invariants](../../packages/fair/tests/settlement-invariants.test.ts).
   Offer a docs/SDK path beside business Sign Up and Demo.
5. **Accountable agent operations** (`account-spend`, `emit-local-usage`):
   [Spend panel tests](../../apps/kernel/app/jin/__tests__/spend-panel.test.tsx)
   and [emitter delivery tests](../../packages/usage-emitter-claude-code/tests/client.test.ts)
   are current proof; complete cross-surface metering and production
   reconciliation are not. Keep this promise qualified until the gaps below land.

Suggested positioning: **“Identity and authority for AI agents. Give each agent
an identity, grant only the authority it needs, and inspect signed approvals and
action records.”** This is a proposal for #3284, not an approved DECISION.
The epic's anonymized travel/supply-chain references are proposed sales proof;
this code audit cannot validate their agreements or outcomes. Do not claim live
usage, customer counts, revenue or a universal “every action” guarantee.

## Gaps and limitations

Core-weight partial actions (none currently graded dormant):

- **`evaluate-platform`** — protocol-matrix front door, `/register` → subscribe,
  no demonstrated direct business Sign Up/Demo journey. #3284 owns positioning;
  #3347 owns summary-first page structure.
- **`org-held-keys`** — provider parity, assigned-bot seal writers and canonical
  custody/model selection: #3341, #3342, #3343; holder/use separation #3318 and
  real assigned-bot completion report #3329. Tested fixture success must not be
  substituted for that outstanding consumer proof.
- **`account-spend`** — #2029 / #3142 public cost proof, #3137 billed statements,
  #3139 local compute metering, #3140 emitter deployment, #3278 / #3263 signed
  receipt versus projection parity. A working Spend panel is not full accounting.
- **`emit-local-usage`** — deploy and register idle emitters (#3140), then surface
  emitter health (#3138). Recent source history prevents an unsupported dormant
  grade.

Additional boundary gaps, not fixed here:

- Scoped authority still has legacy agent-membership fallback (#3012);
  proposal degraded/expiry presentation has #3020 / #3019. Live narrow paths do
  not make the entire authority migration complete.
- Access-bearer metadata currently binds the personal caller in its
  [list route](../../apps/kernel/app/auth/api/access/bearers/route.ts); do not
  infer acting-organization parity from the shared `/jin` page. External consent
  requests, operator proposals and app sign-in consent are separate rails.
- Corpus context, membership, layered search, continuous sync and real-consumer
  proof: #3086, #3100, #3101, #3085, #3091. Corpus's README documents explicit
  grant checks; never describe organization membership as current corpus access.
- Broker-agent's `manage_reach` and `respond_to_match` in
  [tools.ts](../../apps/broker-agent/src/tools.ts) return text without persistence;
  its README says it is not in the production process list. Availability and
  Telegram coordination remain partial side effects, not B2B pillars.
- The [vault spec](../../apps/kernel/api-spec/vault.yaml) explicitly does not
  backfill the full older vault surface. #2978 tracks UI controls in specs;
  this map is not a claim the spec catalog is exhaustive.
- The [media spec](../../apps/kernel/api-spec/media.yaml) advertises hard-delete
  semantics, and chat/calendar specs contain deletion language. This conflicts
  with the history-preserving direction; record the contract discrepancy rather
  than modify a route or endorse deletion.
- Current chat is **not E2EE**; the
  [chat spec](../../apps/kernel/api-spec/chat.yaml) says TLS plus plaintext at
  rest. Federation's 0.55 authority/admission work remains #3305 / #3307.
- Shared input/chat UI exports have thin direct tests (`compose-ui`); dev
  previews are not end-to-end proof. Events/Market/Learn require audits of their
  extracted repositories before any maturity or adoption claim.

These are audit findings or existing issues, **not newly filed work**.

## Maintenance and validation

Run `node scripts/validate-capabilities.mjs` from the repository root, or
`pnpm exec vitest run scripts/__tests__/validate-capabilities.test.mjs` for
negative/schema tests. CI's existing Test shards discover that test file; no
product/package configuration is changed.

Add or regrade actions when a page, service spec or SDK changes. Update the
coverage index, cite actual code and relevant tests, record a git-log date, and
update the audience table together. New apps must have at least one action.
The validator rejects missing fields, unknown enums, duplicate IDs, malformed
entry points/dates/commits, unsafe or missing evidence paths, unsupported
live/works evidence, missing page/spec/package coverage, broken capability
references, and table drift. It cannot prove semantic correctness, deployment
or adoption: those still require human evidence review.
