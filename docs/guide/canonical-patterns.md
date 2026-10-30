# Canonical Patterns

> **Read this before writing code in a seam between primitives** (auth, settlement,
> attribution, identity, checkout). Each row is a primitive that already exists and is
> the *one* correct way to do that thing. **Do not re-implement these inline.** If the
> canonical primitive doesn't cover your case, *extend it with an option* — don't fork it.
>
> Why this file exists: the system stays coherent when every change routes through the
> canonical pattern. Inline re-implementations drift, diverge on money/identity, and show
> up as cognitive-complexity hotspots. This index is the map of foundations to copy from.

## How to use this (humans and coding agents)

1. Before writing logic at a primitive boundary, check this table for an existing primitive.
2. Import and call it. Do not paste an equivalent inline.
3. If it doesn't fit, add a parameter/option to the canonical function and document it here.
4. New canonical primitive? Add a row.

## The primitives

| Concern | Canonical primitive | Location | Do NOT |
|---------|--------------------|----------|--------|
| **App/agent auth + scope** | `requireAppAuth(request, { scope })` | `packages/auth/src/require-app-auth.ts` | Read `x-app-did` / validate scopes inline. Use the dual-path: app-DID header → `requireAppAuth`; else `requireAuth`. Accepts both user-delegated (`app+jwt`) and session-less service (`app-service+jwt`) tokens — see the next row for the latter. |
| **Session-less service credential (machine-to-machine reads)** | `POST /auth/api/apps/token/service` to mint, `requireAppAuth(request, { scope })` to gate | `apps/kernel/app/auth/api/apps/token/service/route.ts`, [service-credentials.md](./service-credentials.md) | Borrow a human's attestation/session for a webhook, cron, or other automated caller. A registered app proves possession of its own keypair and gets a token attributed to its own DID (`userDid: ''`, `isServiceToken: true`) — never a borrowed human identity. |
| **Session auth** | `requireAuth(request)` / `optionalAuth(request)` | `@imajin/auth` | Parse the session cookie or call `/api/session` by hand. |
| **Legal name / postal address disclosure** | `getLegalEntity(did, viewerDid)` | `apps/kernel/src/lib/profile/legal-entity.ts` | Copy fields into identities, profiles or article metadata, or read the private source through broad media scopes. This verifies the signed `legal-entity:v1` source and gates each field at read time. Owner editing uses `/auth/legal-entity`; invoice snapshots/PDFs are separate (#3072/#3073). |
| **Corpus source ownership** | `resolveCorpusDid(source, principalDid)` + `authorizeCorpusOwner` | `apps/kernel/src/lib/kernel/corpus-owner.ts`; source parser in `@imajin/auth` | Use the caller as a GitHub index owner, hardcode an org DID, or treat source resolution/membership as a grant. Resolve the registry group alias and check the owner's live corpus grant before minting a claim. |
| **App consent / surplus revoke** | `upsertAppAuthorization(consent)` / `revokeAppAuthorization(params)` | `apps/kernel/src/lib/auth/upsert-app-authorization.ts` | Select an arbitrary live grant or mint inline. Both consent paths and explicit revoke share a per-(principal, app) transaction advisory lock; signed revocations, refresh invalidation and the surviving app-channel projection commit together. |
| **Effective DID (app or session)** | `resolveEffectiveDid(request, { scope, service })` | `packages/auth/src/resolve-effective-did.ts` | Omit the owning service or infer it from the app scope. Restricted controllers require an explicitly allowed service; an act-as refusal is a 403, never a personal-DID fallback. |
| **Group ownership transfer** | `ownershipTransfer(groupDid, actor, operation, input)` | `apps/kernel/src/lib/auth/ownership-transfer.ts` | Write owner roles or `identities.metadata['pending-owner-transfer']` directly. The primitive checks the node-selected `identity.ownership.policy`, shared delegation gate and explicit human recipient acceptance, locks the group identity, and commits the signed transfer attestation atomically with role/profile changes. Configure the policy id through the existing operator `PUT /api/admin/config` with `{ "key": "identity.ownership.policy", "value": "owner-only" }`; a replacement policy must be registered in `ownership-policy.ts`, and unknown ids fail closed. |
| **Principal ↔ agent binding (`serviceOf`) + live connection** | `resolveServingAgents(principalDid)`, `listServiceOf(agentDid)` | `apps/kernel/src/lib/auth/agent-service.ts`, [agent-service-binding.md](../agents/agent-service-binding.md) | Query `identity_members` for agents inline, address a gateway instead of the agent DID, or treat `subtype='agent'` / a `serviceOf` entry as authority — authority is only `resolveAgentAuthority()`. |
| **Settlement (fee split → ledger/balances)** | `settlePayment()`, called by `POST /pay/api/settle` (and `settleReactor` via the bus) | `apps/kernel/src/lib/pay/settle-core.ts`, `apps/kernel/app/pay/api/settle/route.ts`, `packages/bus/src/reactors/settle.ts` | Write `feeLedger` / `balances` rows inline. **Known debt:** the Stripe webhook's consumer still credits `feeLedger`/`balanceRollups` inline (`apps/kernel/src/lib/pay/stripe-bus-consumer.ts` — the `pay-stripe` reactor on the #1785 `stripe.*` bus events, #2177; the webhook routes are ingress only) via a different manifest shape — it now shares `settlePayment()`'s signature-verification primitive (non-blocking), but not its crediting mechanics. See #1073 and "Known divergences" below. |
| **.fair manifest build** | `buildFairManifest(...)` | `packages/fair` | Hand-assemble fee/chain objects. |
| **.fair manifest validate / verify / sign** | `validateManifest`, `verifyManifest`, `signManifest` | `packages/fair` | Re-implement chain validation or signature checks. |
| **.fair settlement field disclosure** | `composeEffectivePolicy(communityOverlay, subjectGates)` + `applyDisclosureGates(manifest, policy, grantedFields)` | `apps/kernel/src/lib/media/fair-disclosure-policy.ts` | Hard-code which `.fair` fields to include/exclude in a route. Use the three-layer model (floor → community overlay → subject gates) and query `kernel.consent_grants` for `on-consent` fields. Overlay is data: set `fair.disclosure.overlay` in `nodeConfig`. See [fair-settlement-disclosure.md](./fair-settlement-disclosure.md). |
| **Rate limiting** | `rateLimit(key, limit, windowMs)`, `getClientIP` | `@imajin/config` | Hand-roll a limiter. Key by IP *and* (for abuse-sensitive flows) by email/subject. |
| **Verified domain ownership and routing** | `addDomain`, `verifyDomain`, `removeDomain`, `listDomains`, `resolveVerifiedDomain`, `issueImajinDomain`, `resolveRoutableDomain` | `apps/kernel/src/lib/domains/service.ts` | Accept a caller-supplied site owner, invent verified evidence, route pending claims, or use the node identity as the Imajin organization. Mutating routes must enforce shared delegation policy and owner/admin authorization. |
| **Domain-scoped vault credentials** | `resolveDomainCredential(domain, granteeDid, purpose)` | `apps/kernel/src/lib/vault/domain-credential.ts` | Fall back to node environment credentials or raw unseal. Resolve verified binding → zone owner → active subject/purpose/grantee-bound grant → existing grant fetch. |
| **Sealed bank-details record** | `saveBankDetails(actor, input)`, `readBankDetails(ownerDid)`, `deleteBankDetails(actor)` | `apps/kernel/src/lib/vault/bank-details.ts`, `/auth/api/bank-details` | Store identifiers in document/metadata, use generic vault fetch/renewal, or add identity columns. The trusted kernel read returns non-secret fields, their visibility and `hasRail` without unseal; external disclosure must apply visibility. Saves are full immutable replacements. Existing node-delegated Tier 0 custody only (not zero-custody); Tier 1 saves fail closed. |
| **Server-held group signing-key custody** | `vault:custody-group-key` / `vault:revoke-group-key` on the existing `/jin` vault proposal rail | `apps/kernel/src/lib/vault/group-key.ts` | Decrypt in a shell, generate replacement secrets, export custody fields, or grant to caller-selected nodes. The current owner/admin operator countersigns identifiers only; the kernel authenticates the stored seed, matches its public key and reuses static-secret sealing and purpose fetch. |
| **SSH CA lifecycle and public trust** | `mintSshCa`, `revokeSshCa`, `trustedSshCaKeys`, `lockSshCaPurpose` | `apps/kernel/src/lib/vault/ssh-ca.ts` | Generate another keypair path, export the CA seed, or mutate its grant through generic vault tools. Lifecycle uses `mintKeypair` and retained mint records with atomic signed attestations. Certificate issuance must import the max-TTL cap from `ssh-ca-policy.ts` and hold the purpose lock through active lookup and signing; never cache a signer. |

### SSH certificate signing

SSH certificate issuance uses `signSshCert` in `apps/kernel/src/lib/vault/ssh-cert.ts`
and the `/api/vault/ssh-ca/sign` contract. Create/revoke SSH operation grants on
`/api/vault/ssh-ca/grants` and `/api/vault/ssh-ca/grants/revoke` with CA-mint authority.
These reuse vault delegation rows, with signed principal/forced-command/host scope
and **no wrapped CA key**. The CA's separate custody grant remains node-only.
Signing holds the purpose lock and grant row locks through the signed issuance
commit. Never expose an unseal API or let a caller supply certificate options.
Public trust is a lock-free, non-mutating deadline projection; mutations and
successful signing reconcile retirement attestations. Allowed hosts gate issuance;
OpenSSH user certificates do not constrain the destination host by themselves.
### App-owned checkout patterns

For onboarding email after an app-owned hosted checkout, call
`POST /auth/api/onboard/send` with `{ transactionId }` and the app's own
operator-approved `onboard:send` service token (#2537). The kernel enforces
app binding plus the recorded seller's ownership/live authorization, resolves
the buyer from kernel credentials or the seller's recorded Stripe session,
and emails the existing magic link privately. Only send status leaves the
kernel; apps must never mint, receive, embed, log or redeem its verification
bearer. A node-signed `onboard.link.sent` record binds the app and order.
Free/EMT resources without a kernel-bound transaction fail closed; see the
auth API spec for the supported hosted-checkout contract and failure semantics.

The former events checkout-identity, ticket reconciliation, contact-email and
order-creation helpers are no longer kernel primitives or import targets.
`apps/events` was pruned in #2517; consult [ima-jin/events](https://github.com/ima-jin/events)
for its current implementation. External apps use published SDKs and the
[public registered-app API](../REGISTRATION.md), never removed app internals
or direct SQL against another service's tables.

## Connector lifecycle and app-facing invocation
For app-hosted connectors, use `/connections/api/upstreams` to declare targets on
the existing app registration, `/connections/api/upstreams/connection` for personal
member custody, and `/connections/api/upstreams/call` for app-service invocation.
Never grant the app a raw upstream credential. Both this path and personal MCP use
`authorizeMemberConnection` in `apps/kernel/src/lib/kernel/member-connection-gate.ts`
for live member consent, connection state, org standing and org-admin suspension;
do not fork checks into routes. Org admins manage suspension on `/auth/members`
via session-only `/auth/api/org-connections`. `removeGroupController` persists
and signs suspension in its existing removal transaction. Retained org/member/
provider/slot policies prevent reconnect/retag bypass; service-wide policies also
cover future connections. Personal use is unaffected. Resume each policy explicitly.
The outbound transport shares credential injection and echo refusal with MCP.
Admission limits run before any database read. Successful calls are recorded with
signed member/app/org metadata, as are authorized upstream failures; refusals
make no upstream call and write nothing permanent. Never audit an app-selected
member until the call has passed authorization and reached the upstream transport.
Member bindings include the canonical set of declared path/method pairs: additions,
changes and removals require reconnecting, while reordering does not. Earlier
destination-only bindings require one reconnect. The API-only connect/status
responses include a sorted plain-text `permissions` list (for example `GET /me`);
with `connected: false` it is the current review list, not previously granted consent.
See `/connections/api/spec` for exact declarations, destination binding and separate
read/write grants; neither app registration nor org membership is member consent.

Apps witness and invoke; profiles own connector lifecycle. A vertical app must not implement connector selection, OAuth, token-paste, token storage, or credential refresh. The user connects a provider on their Imajin profile once, then apps call kernel app-auth routes with the user's consent.

Use `GET /connections/api/connectors/status` with the `connectors:read-status` app scope to render live connected-service state. The response is only `{ id, connected, scopes }[]`; it never includes token, config, or secret fields. For actions, call the connector/domain route with the existing connector scope, such as `quickbooks:write`; the route resolves app-auth `userDid`, unseals the user's profile-owned token server-side, and returns only action output.

## The rule of thumb

> If you find yourself writing logic that *feels* like it belongs to a primitive
> (money movement, identity, attribution, auth), stop and look here first. The cost
> of one more inline re-implementation isn't this function — it's the next three that
> copy it, and the day two of them disagree on a payout.

## Known divergences (tracked, not yet converged)

- **Settlement:** `POST /pay/api/settle` delegates to the shared `settlePayment()` primitive (`apps/kernel/src/lib/pay/settle-core.ts`, #1073). The Stripe webhook consumer (`stripe-bus-consumer.ts` — since #2177 `pay/api/webhook/route.ts` only verifies the signature and republishes the delivery as a `stripe.*` bus event) still settles Stripe payments inline via a structurally different `.fair` manifest shape (fractional shares of a checkout total, credited to `feeLedger`/`balanceRollups` — vs. canonical's absolute-dollar chain credited to `balances`/`transactions`), including processing-fee reconciliation that `/pay/api/settle` lacks. That ledger/crediting split is intentional, not an oversight: `feeLedger`/`balanceRollups` are read by other systems (e.g. QuickBooks export, transaction history), so rerouting the webhook's money-crediting through the canonical dollar-chain primitive would be an uncontrolled behavior change, not a refactor.
  **Tax (#2435):** the webhook honors a `.fair` `taxes[]` on the generic checkout. `processChainDistribution` computes every chain share on the pre-tax basis only (Stripe total minus Σ`taxes[].amount`; the processor-fee estimate stays on gross, the seller absorbing Stripe's fee on the tax) and books each tax row as a trust liability — a `feeLedger` row (`role: 'tax'`, `status: 'held_in_trust'`) plus a `transactions` row tagged `{ tax: true, trustLiability: true, remitted: null, … }` that `getTaxRemittanceOwed` reads. No internal balance is credited: the checkout is a Stripe destination charge, so the tax is already in the seller's connected account (`validateCheckoutBody` requires `taxes[].collectorDid` to be the seller).
  What #1073 DID converge: both paths now share `settlePayment()`'s manifest-signature-verification primitive (`verifySettlementSignature`). The webhook gates on it non-blockingly — an absent/invalid signature never stops settlement (Stripe already collected the money) but now emits a durable `settlement.manifest.unverified` attestation instead of the prior silent no-check-at-all behavior. Full monetary-mechanics unification remains explicit follow-up work, not done here.
