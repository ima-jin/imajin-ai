# Spike: XPRIZE connector wiring diagnosis (#1748)

Diagnosis-only spike. No production code was modified. Scope: the three
connector/auth wiring bugs reported against the AgriFortress XPRIZE app
(`dev-integrity.imajin.ai`, app registration `app_zRV78KbMC2X09IRE`).

The app repo (`catalyst-power/xprize`) was not available in this environment,
so the app-side analysis below is inferred from the kernel's contract with
app-authenticated callers (`packages/auth/src/require-app-auth.ts`,
`apps/kernel/app/connections/api/connectors/status/route.ts`) rather than
from reading the app's own source.

## Issue 1 — Gemini shows "Status unavailable" despite a sealed key

### Root cause

`keySealed()` (`apps/kernel/src/lib/kernel/connector-token-paste.ts:349-351`)
was correctly hardened by #1724 to require an **active delegation grant**, not
just a vault entry:

```ts
async function keySealed(ownerDid: string): Promise<boolean> {
  return (await vaultFieldStatus(keyField(ownerDid))) === 'ready';
}
```

The grant is normally created inside the same call that seals the key —
`sealAndStoreV2` (`apps/kernel/src/lib/vault/index.ts:293-454`) — but it forks
on `isVaultTier1()` (`apps/kernel/src/lib/vault/sealing.ts:236-238`):

- **Tier 0** (no `VAULT_OWNER_X_PUB` / `VAULT_OWNER_ED_PUB`): the node acts as
  its own owner agent and inserts an **active** `vault_delegation_grants` row
  synchronously, self-granted to the node's own DID
  (`index.ts:399-453`).
- **Tier 1** (both env vars set): the node cannot mint the grant itself. It
  writes only a `vault_grant_requests` row with `status: 'pending'` and
  publishes `vault.grant.requested` (`index.ts:337-397`), expecting an
  **external owner agent** (`imajin-cli vault serve`, polling
  `GET /api/vault/grants/pending`) to recover the wrapped field key, sign a
  canonical grant, and `POST /api/vault/delegation/grant`
  (`apps/kernel/app/api/vault/delegation/grant/route.ts`) to actually create
  the `vault_delegation_grants` row.

The observed dev-integrity state — `vault_owner_envelopes` populated,
`vault_delegation_grants` empty — is exactly the signature of a Tier 1 seal
whose handshake was never completed: the envelope is written in *both* tiers
(`writeOwnerEnvelope` is called on both branches), but the grant only
materializes once an owner agent answers. AgriFortress is an org identity with
no personal device running `imajin-cli vault serve`, so if this kernel is
configured for Tier 1, the request can never be fulfilled and sits in
`vault_grant_requests` forever.

### Confirm before fixing

```sql
-- Look for a stuck handshake for this exact field.
select requestId, status, createdAt, expiresAt
from kernel.vault_grant_requests
where field = 'gemini-api-key:did:imajin:ApSPznft92DsP85dUf7dPKUYESGUHXzi1tvw8KMcCbdo';
```

and check whether the dev-integrity kernel process has `VAULT_OWNER_X_PUB` /
`VAULT_OWNER_ED_PUB` set. A pending row plus both env vars set confirms Tier 1
is active with no fulfiller.

### Proposed fix

**Option A (most likely correct for this environment) — kernel is
mis-configured for Tier 1; run it as Tier 0.** There is no evidence anywhere
in the codebase of an automated Tier 1 fulfiller for headless org identities —
`GET /api/vault/grants/pending` is documented as "polled by `imajin-cli vault
serve`" and nothing else consumes it. If dev-integrity was never meant to run
Tier 1 custody, unset both env vars for that deployment and re-seal the key
(re-POST the same key to `/gemini/api/token`). No code change; `sealAndStoreV2`
then takes the Tier 0 branch and inserts the active grant in the same request:

```ts
// apps/kernel/src/lib/vault/index.ts:399-453 — Tier 0 branch, unchanged.
// Re-running sealApiKey() under Tier 0 produces an ACTIVE grant synchronously:
await writeOwnerEnvelope({ field, keyId, fieldKey, ownerXPub: getOwnerXPublicKey() });
// ...
await db.insert(vaultDelegationGrants).values({ ..., status: 'active', ... });
```

**Option B (if Tier 1 is intentional platform-wide policy) — build a headless
fulfiller for org/service DIDs.** Org identities like AgriFortress have no
personal device to run `imajin-cli vault serve`. This needs a small
server-side service that holds an owner keypair on AgriFortress's behalf,
polls `GET /api/vault/grants/pending`, and auto-signs+posts grants for a
trusted allow-list of service DIDs — effectively an automated Tier 1 owner
agent for org accounts. This is a real feature gap, not a one-line fix, and
should be scoped as its own follow-up if Tier 1 is required in production.

### Kernel vs. app

Kernel-only (vault custody config / operational fix). No app-side change.

### Scope vocabulary

Not implicated.

### Verdict

Root cause confirmed by code: `sealAndStoreV2`'s Tier 1 branch never
completes without an external owner agent, and none exists for AgriFortress's
org DID. **Recommend Option A** — verify Tier 1 env vars on dev-integrity and
switch to Tier 0 for this deployment unless Tier 1 was deliberately enabled;
re-seal the key afterward.

## Issue 2 — Voice Note 403: "Scope 'infer:provide' was not granted"

### Root cause

This is **not a scope-name bug in the kernel** — `infer:provide` is the
correct, deliberately-designed scope for this exact flow, and it already
exists in the vocabulary:

```ts
// packages/auth/src/scope-vocabulary.ts:232
{ scope: 'infer:provide', connector: null,
  label: 'Provide app-owned inference credentials for delegated inference' },
```

It's a **platform scope** (`connector: null`), granted through the OAuth
consent screen to a *registered app*, not through any connector's
scope-manifest. It is distinct from `inference:read` / `inference:write`,
which are **MCP-surface scopes** (`connector: 'mcp'`,
`scope-vocabulary.ts:328-334`) that gate a *user's own* MCP client reading
session results / triggering inference — a completely different surface from
"an app supplies its own credential to run inference for a delegated user."

The capture route's check —
`requireAppAuth(request, { scope: 'infer:provide' })`
(`apps/kernel/app/api/inference/capture/route.ts:174`) — matches the #1624
design and is covered by tests that predate this ticket:

```ts
// apps/kernel/app/api/inference/capture/__tests__/route.test.ts:210-216
it('requires the infer:provide app scope', async () => {
  mockRequireAppAuth.mockResolvedValueOnce(appAuth());
  await POST(makeReq());
  expect(mockRequireAppAuth).toHaveBeenCalledWith(expect.anything(), { scope: 'infer:provide' });
});
```

The 403 happens because `infer:provide` is checked against the **scopes the
user actually approved for this app**, sourced from the app's
`app.authorized` attestation payload
(`apps/kernel/app/auth/api/apps/token/route.ts:121-127` and
`apps/kernel/app/auth/api/apps/token/verify/route.ts:46-50`, both of which
produce the exact error string `Scope '${scope}' was not granted`). A user can
only approve scopes the app *requested* at registration
(`registry.apps.requested_scopes`, `migrations/0007_registry_apps.sql:15`).
The XPRIZE registration requests `inference:read, inference:write,
supply:read/write, quickbooks:read/write, media:read/write,
identity:read/write` — `infer:provide` is simply missing from that list, so it
can never appear in any user's consent grant, and the app-token mint/verify
step rejects it every time.

### Proposed fix

Update the AgriFortress app registration (`app_zRV78KbMC2X09IRE`) to include
`infer:provide` in `requested_scopes`, then have AgriFortress (the app owner)
re-consent so a fresh `app.authorized` attestation includes it:

```sql
-- registry.apps is the source of truth for what an app may ask a user to grant.
update registry.apps
set requested_scopes = requested_scopes || '["infer:provide"]'::jsonb
where id = 'app_zRV78KbMC2X09IRE'
  and not (requested_scopes @> '["infer:provide"]'::jsonb);
```

followed by the app re-driving the `/auth/authorize` consent flow so the
owner/admin approves the new scope and a fresh attestation is issued
(re-consent is required — the existing `app.authorized` attestation's
`payload.scopes` is fixed at issuance time and does not retroactively pick up
newly-requested scopes).

`inference:read` / `inference:write` should stay in the registration if the
app also drives MCP tools that read/trigger inference sessions directly — they
serve a different surface and are not redundant with `infer:provide`.

### Kernel vs. app

App registration / consent data fix (`registry.apps.requested_scopes` +
re-consent). No kernel code change — the capture route, `require-app-auth.ts`,
and the scope vocabulary are all already correct.

### Scope vocabulary

No update needed. `infer:provide` already exists
(`packages/auth/src/scope-vocabulary.ts:232`) and is exactly the right scope
for this flow.

### Verdict

Kernel code is correct as-is. The bug is an incomplete app registration:
`app_zRV78KbMC2X09IRE` needs `infer:provide` added to its requested scopes and
a fresh user consent grant.

## Issue 3 — QuickBooks shows "connected" for a user who hasn't connected

### Root cause

`GET /connections/api/connectors/status` is app-auth-gated and correctly
scoped to the delegating **user** DID
(`apps/kernel/app/connections/api/connectors/status/route.ts:29-47`), but it
delegates to `readConnectorConnectionStatus(userDid)`
(`apps/kernel/src/lib/kernel/connector-status.ts:66-82`), which reads **every
active `channel_links` row for that user across the whole platform** and
filters only by `row.appDid === connector.connectorDid` — the connector's
fixed, global platform DID (e.g. `did:imajin:quickbooks-connector`,
`apps/kernel/src/lib/kernel/connector-registry.ts:326`), never by the
*invoking app's* DID:

```ts
// apps/kernel/src/lib/kernel/connector-status.ts:38-41
for (const row of rows) {
  if (row.channel !== connector.channel || row.appDid !== connector.connectorDid) {
    continue;
  }
  ...
```

This is **working as designed and as tested** — #1540's test suite
(`apps/kernel/src/lib/kernel/__tests__/connector-status.test.ts:145-183`)
pins exactly this "one connection per provider per user, shared by every
consuming app" contract, and every OAuth-ingestion connector in the registry
(GitHub, QuickBooks) writes `channel_links.appDid` as the fixed connector DID
via the shared scope-manifest core
(`apps/kernel/src/lib/quickbooks/scope-manifest.ts:65-71`,
using `QUICKBOOKS_CONNECTOR_DID` unconditionally) — never the DID of whichever
third-party app drove the OAuth flow. `resolveConfigDidFromAppAuth`
(`apps/kernel/src/lib/kernel/connector-oauth-routes.ts:110-114`) only lets an
app supply its *own OAuth client credentials* for the authorize step; it does
not change who the resulting grant is scoped to.

So Ryan's `channel_links` row from prior, unrelated QuickBooks testing is
genuinely "connected" on the platform, and the kernel is honestly reporting
that fact. The AgriFortress product requirement — "QuickBooks is per-supplier;
someone who hasn't connected through AgriFortress should read as
not-connected" — is a real mismatch with the platform's global,
provider-per-DID connector model, not a defect in that model. Every other
connector (Gemini, Anthropic, GCP, Discord, GitHub) shares the same
"connect once, usable by every authorized app" design intentionally.

### Proposed fix

**Immediate (dev-data fix, unblocks XPRIZE testing today):** revoke Ryan's
stale QuickBooks `channel_links` rows so his status correctly reads
"not connected" until he does connect through AgriFortress:

```sql
update auth.channel_links
set status = 'revoked', revoked_at = now()
where channel = 'quickbooks'
  and did = 'did:imajin:6JSKE52y...'   -- Ryan
  and status = 'active';
```

This does not fix the underlying architecture mismatch — any other user with
a pre-existing platform-wide QuickBooks connection will hit the same false
"connected" state inside AgriFortress.

**Structural options (need a product decision, out of scope to fully design
here):**

- **Kernel option — app-scoped connector custody for QuickBooks.** Extend the
  OAuth connector framework so a connection initiated via an app-auth-driven
  flow records `channel_links.appDid` as the *invoking app's* DID (available
  as `appResult.appAuth.appDid` at connect time) instead of the fixed
  `QUICKBOOKS_CONNECTOR_DID`, then have `readConnectorConnectionStatus` accept
  an optional `callerAppDid` and match against it for connectors that opt into
  per-app scoping. This is a schema/behavior change shared by every OAuth
  connector's connect/callback/status path, not a one-file patch, and would
  need to decide whether GitHub/Discord should also become app-scoped or stay
  global.
- **App option — the app owns its own per-supplier flag.** Keep the platform
  connector model global (matching every other connector), and have the
  AgriFortress/XPRIZE app track its own narrower fact — "has this supplier
  completed *our* QuickBooks connect flow" — in the app's own data store,
  keyed by `(appDid, supplierDid)`, set only when the supplier completes the
  OAuth flow that the app itself initiated. This avoids conflating "has a
  QuickBooks token sealed anywhere on the platform" with "has connected for
  AgriFortress" without changing kernel-wide connector semantics.

### Kernel vs. app

Immediate fix is a data cleanup (no code). The durable fix is most likely an
**app-side** concern (track per-supplier connection state in the app's own
store) unless the platform decides app-scoped connector custody should become
a first-class kernel feature, which is a larger cross-connector design change.

### Scope vocabulary

Not implicated — `quickbooks:read` / `quickbooks:write` are correctly defined
and correctly gate what an authorized app may do with an existing connection;
the issue is entirely about connector *connection* status, not scope
authorization.

### Verdict

Kernel behavior matches its documented and tested design (#1540); this is not
a kernel bug. Recommend the immediate data cleanup for Ryan's stale test rows,
and a product decision on whether QuickBooks needs app-scoped custody
(kernel change) or whether AgriFortress should track per-supplier connection
state itself (app change) — the latter is less invasive and consistent with
how every other connector on the platform behaves.

## Summary table

| # | Symptom | Root cause | Fix location | Scope vocab change |
|---|---|---|---|---|
| 1 | Gemini "Status unavailable" | Tier 1 vault custody seal never completed (no owner-agent fulfiller for AgriFortress's org DID) | Kernel config (vault tier) / ops | No |
| 2 | Voice Note 403 on `infer:provide` | App registration missing `infer:provide` scope; `inference:read/write` is a different, unrelated surface | App registration data + re-consent | No — scope already correct |
| 3 | QuickBooks shows connected incorrectly | Platform connector model is global-per-user by design; stale test data plus a per-app product requirement it wasn't built for | Data cleanup now; app-side (or kernel design decision) for the durable fix | No |
