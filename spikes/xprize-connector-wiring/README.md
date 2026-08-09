# Spike: XPRIZE connector wiring diagnosis (#1748)

Diagnosis-only spike. No production code was modified. Scope: the three
connector/auth wiring bugs reported against the AgriFortress XPRIZE app
(`dev-integrity.imajin.ai`, app registration `app_zRV78KbMC2X09IRE`).

The app repo (`catalyst-power/xprize`) was not available in this environment,
so the app-side analysis below is inferred from the kernel's contract with
app-authenticated callers (`packages/auth/src/require-app-auth.ts`,
`apps/kernel/app/connections/api/connectors/status/route.ts`) rather than
from reading the app's own source.

**Update (live debugging pass):** the original diagnosis below treated these
as three unrelated bugs across vault custody, app scopes, and connector
status semantics. Live debugging against dev-integrity found that framing was
partially wrong. Two of the three original write-ups were red herrings or
only half the story; all three symptoms actually trace back to **one
architectural gap**, described first. Each issue section below is corrected
in place, with the original diagnosis kept (struck through in spirit, not
deleted) so the record of what was initially believed is preserved.

## The Architectural Gap

Every connector status/config/seal route resolves whose credentials to act on
via the same two-line idiom:

```ts
const auth = await requireAuth(request);
// ...
const ownerDid = resolveActingDid(auth.identity);
```

`resolveActingDid` (`packages/auth/src/acting-did.ts:20-22`) returns the
**logged-in user's DID** (or an explicit `actingFor` / `actingAs` delegation
target) — never anything derived from which *app* is calling. That is the
correct model for a person managing their own connector credentials.

But the app-subsidizes-compute model (#1624) intentionally puts API keys and
OAuth app config on the **app owner's DID** (AgriFortress,
`did:imajin:ApSPznft92DsP85dUf7dPKUYESGUHXzi1tvw8KMcCbdo`), not on each
delegated user's DID — that is the whole point of an app subsidizing compute
for users who never bring their own key. `requireAppAuth` even has an
established pattern for this split, used today by the inference capture
route (`apps/kernel/app/api/inference/capture/route.ts:173-201`): resolve an
"acting owner" DID that can differ from the caller's own DID, with a fallback
chain (`appAuth.userDid || x-acting-for header`). None of the three
connector-credential routes below use that pattern, or anything like it —
they resolve exactly one DID, the session user's, unconditionally. So every
one of them ends up asking **"does this logged-in user have keys?"** when the
app-subsidized model requires asking **"does the app owner have keys?"**:

| Route | File | Always resolves ownerDid via |
|---|---|---|
| Gemini scope-manifest GET/POST | `apps/kernel/src/lib/kernel/scope-manifest-route.ts:114-118, 165-169` | `requireAuth` → `resolveActingDid` |
| Gemini/Anthropic token-seal GET/POST/disconnect | `apps/kernel/src/lib/kernel/connector-token-route.ts:71-75, 87-91, 172-176` | `requireAuth` → `resolveActingDid` |
| QuickBooks configure POST | `apps/kernel/src/lib/kernel/connector-oauth-routes.ts:403-407` (via `createConfigureHandler`, wired from `apps/kernel/app/quickbooks/api/configure/route.ts`) | `requireAuth` → `resolveActingDid` |

One gap, three symptoms: Gemini's status card, the QuickBooks configure step,
and (indirectly, via a stale consent grant rather than this exact code path)
the inference capture scope check all inherited assumptions from the
per-user-key world that #1624 already broke.

## Bug 1 — Gemini status "unavailable" (corrected diagnosis)

### Original diagnosis (partially right, but not the live bug)

The original spike below (kept for the record) attributed this to a Tier 1
vault custody handshake that never completed — the key was sealed but no
`vault_delegation_grants` row existed because no external owner agent was
running for AgriFortress's org DID. **That was true initially and has since
been fixed**: the key was re-sealed under Tier 0, and an active delegation
grant now exists.

### What's actually still wrong

The status still shows "unavailable" after the grant fix, because:

1. `GET /gemini/api/scope-manifest` is wired through
   `createConnectorScopeManifestRoute`
   (`apps/kernel/app/gemini/api/scope-manifest/route.ts`), whose `getExtraFields`
   calls `geminiKeySealed(ownerDid)`
   (`apps/kernel/src/lib/gemini/scope-manifest.ts:25-31`... wired from
   `apps/kernel/src/lib/gemini/connector.ts`).
2. `ownerDid` comes from `resolveActingDid(auth.identity)` inside the shared
   factory (`apps/kernel/src/lib/kernel/scope-manifest-route.ts:114-118`) — the
   **logged-in user**, Ryan (`did:imajin:6JSKE52y...`).
3. The Gemini key is sealed under `gemini-api-key:did:imajin:ApSPznft92DsP85dUf7dPKUYESGUHXzi1tvw8KMcCbdo`
   — AgriFortress's DID, per the app-subsidized model.
4. `keySealed(ryanDid)` checks a vault field that was never written for Ryan's
   DID → `false` → the card renders "unavailable", even though the key is
   correctly and durably sealed for the app owner.

The original Tier-1-handshake theory explained why the grant was briefly
missing; it does not explain why the card is still broken today with an
active grant in place. The DID mismatch does.

### Kernel vs. app

Kernel change required: `scope-manifest-route.ts`'s `GET`/`POST` need an
app-context resolution path (see **Proposed code fix** below). Not an app or
data fix.

### Scope vocabulary

Not implicated.

## Bug 2 — `infer:provide` 403 (corrected diagnosis)

### Original diagnosis (wrong on the scope registration)

The original write-up (kept for the record) assumed `infer:provide` was
missing from `registry.apps.requested_scopes` entirely. **That premise was
wrong** — `infer:provide` was already present in the AgriFortress app's
requested scopes by the time this was re-checked live.

### What's actually wrong

The scope exists in the vocabulary
(`packages/auth/src/scope-vocabulary.ts:232`) and in the app's
`requested_scopes`. The capture route's check —
`requireAppAuth(request, { scope: 'infer:provide' })`
(`apps/kernel/app/api/inference/capture/route.ts:174`) — is correct and
unchanged. The actual failure is that **the minted app token for Ryan's
current session** carries the older scope set:

```
["supply:read","supply:write","media:read","media:write","quickbooks:read","quickbooks:write"]
```

`infer:provide` is not in it. Scopes are fixed into the `app.authorized`
attestation at consent time (`apps/kernel/app/auth/api/apps/token/route.ts`,
`.../apps/token/verify/route.ts`); Ryan's existing consent grant predates
`infer:provide` being requested, and re-registering the app's
`requested_scopes` does not retroactively widen attestations issued before
that change. Every subsequent app-token mint for Ryan carries the stale set
until he re-consents.

### Proposed fix

1. **Immediate:** Ryan (and any other user who consented before
   `infer:provide` was added) needs to re-run the `/auth/authorize` consent
   flow so a fresh attestation with the current `requested_scopes` is issued.
2. **Durable — re-consent detection:** the integrity app should not have to
   rely on someone noticing a 403 to discover a stale grant. When the app
   mints or refreshes its token and the returned scopes don't cover what it
   expects to need (e.g. `infer:provide` absent while the app's own manifest
   declares it uses that flow), the app should detect the gap and redirect
   the user through `/auth/authorize` again automatically rather than
   surfacing a raw 403 from the capture route. This is an app-side
   responsibility (the app knows what scopes it depends on); the kernel's
   token verify response already carries enough information (`scopes` on the
   `AppAuthContext`, `packages/auth/src/require-app-auth.ts:4-10`) to make
   this detectable without a new kernel endpoint.

### Kernel vs. app

No kernel code change — `require-app-auth.ts`, the capture route, and the
scope vocabulary are all correct. This is a stale user consent grant (data)
plus a missing re-consent-detection affordance (app-side).

### Scope vocabulary

No update needed. `infer:provide` already exists and is correctly scoped.

## Bug 3 — QuickBooks connect_error (corrected diagnosis)

### Original diagnosis (partially right, but incomplete)

The original write-up (kept for the record) found Ryan's stale, unrelated
QuickBooks `channel_links` rows made his status read "connected" when he
hadn't connected through AgriFortress, and recommended a data cleanup. **That
part was correct and has been done** — Ryan's stale `channel_links` rows were
revoked.

### What's actually still wrong

With the stale personal connection cleared, clicking "Connect QuickBooks" now
fails differently: it crashes with

```
duplicate key violates unique constraint "uniq_vault_delegation_active"
```

on field `quickbooks-config:did:imajin:ApSPznft92DsP85dUf7dPKUYESGUHXzi1tvw8KMcCbdo`
— i.e. AgriFortress's own config field, not Ryan's. There is already an
**active** `vault_delegation_grants` row for that exact
`(subject, granted_to, field, key_id)` tuple from AgriFortress's prior setup,
and the configure route's insert collides with it instead of superseding it.

Two things compound here, both downstream of the same architectural gap:

1. `POST /quickbooks/api/configure` is wired through `createConfigureHandler`
   (`apps/kernel/src/lib/kernel/connector-oauth-routes.ts:386-428`), which —
   like the Gemini routes above — resolves `ownerDid` unconditionally via
   `requireAuth` → `resolveActingDid` (line 403-407) and calls
   `storeConfig(ownerDid, config)` → `sealAndStoreV2(configField(ownerDid), ...)`
   (`apps/kernel/src/lib/kernel/connector-oauth.ts:412-414`). Unlike
   `createConnectHandler` / `createCallbackHandler`, which already accept an
   optional `configDid` for the split app-owned-config model (#1704, see
   `resolveConfigDidFromAppAuth`,
   `apps/kernel/src/lib/kernel/connector-oauth-routes.ts:110-114`),
   `createConfigureHandler` has **no equivalent app-context parameter at
   all**. So whether a given configure POST lands on Ryan's field or
   AgriFortress's field depends entirely on incidental request headers
   (e.g. whether an `X-Acting-For` happened to be attached), not on a
   deliberate "seal this under the app owner" decision — exactly the kind of
   inconsistency that produces an orphaned, un-superseded row for one DID
   while another request path writes to a different DID.
2. Independent of #1, `sealAndStoreV2`'s supersede step is a **check-then-act**
   sequence, not atomic: it peeks the current vault entry
   (`vaultService.peek(field)`) and only supersedes the prior
   `vault_delegation_grants` row `if (existingEntry?.custodyScheme ===
   'delegation-grant')` (`apps/kernel/src/lib/vault/index.ts:308,
   430-439`) before inserting a fresh active row. If the vault entry and the
   grants table ever diverge — e.g. a grant created outside this exact
   code path, a partial failure between the two writes, or (per #1) a
   different-but-colliding request that already wrote the "latest" entry —
   the supersede check is skipped and the following `INSERT` hits
   `uniq_vault_delegation_active`
   (`apps/kernel/src/db/schemas/vault.ts:72-74`) instead of rotating
   gracefully. This is exactly the failure mode observed.

### Proposed fix

1. **Configure route needs app-context resolution**, same shape as the fix
   for Bug 1 (see below) — the QuickBooks config for an app-subsidized
   connection must be deliberately sealed under the app owner's DID, not
   whatever `resolveActingDid` happens to return for a given request.
2. **Make the seal path idempotent regardless of cause.** Replace the
   peek-then-supersede-then-insert sequence in `sealAndStoreV2` (and audit
   `sealAndGrantStaticSecret`, `apps/kernel/src/lib/vault/index.ts:667-799`,
   for the same shape) with a real upsert against the partial unique index —
   `INSERT ... ON CONFLICT (subject, granted_to, field, key_id) WHERE
   status = 'active' DO UPDATE ...` (superseding the old row's fields in
   place) — so a rotate can never race or silently miss an existing active
   row, independent of how that row got there.

### Kernel vs. app

Kernel change required on both fronts: configure route app-context support,
and the vault seal/supersede path. Not an app or data-only fix this time —
the earlier data cleanup was necessary but not sufficient.

### Scope vocabulary

Not implicated — `quickbooks:read` / `quickbooks:write` are correctly
defined; this is entirely about connector *credential sealing*, not scope
authorization.

## Proposed code fix (per route)

All three fixes below follow the same shape: resolve an **app-owner DID**
when the request carries app-auth context, falling back to the session
user's DID (`resolveActingDid`) when it does not — preserving today's
behavior for connectors used outside the app-subsidized model.

### Scope-manifest route (`scope-manifest-route.ts`)

When the request carries an `X-App-DID` (or bearer app token), resolve
`ownerDid` as that app's `owner_did` from `registry.apps`
(`apps/kernel/src/db/schemas/registry.ts:301-319`, column `ownerDid` at
line 303) instead of the logged-in user. Concretely: call `requireAppAuth`
first (mirroring the inference capture route's
`resolveInferenceAuth`,
`apps/kernel/app/api/inference/capture/route.ts:173-201`); on success, look
up `appAuth.appDid` in `registry.apps` and use its `ownerDid`; on failure or
absence of app-auth headers, fall through to today's `requireAuth` →
`resolveActingDid` path unchanged. This touches both `GET`
(`scope-manifest-route.ts:111-150`) and `POST` (`152-215`).

### Token-seal route (`connector-token-route.ts`)

Same pattern, applied to `GET`/`POST`/disconnect
(`connector-token-route.ts:68-78, 84-120, 169-191`): when sealing within an
app context, seal under the app owner's DID resolved the same way as above,
not the caller's own DID. This is what makes Bug 1 actually resolve — Gemini
GET checks would then look up `gemini-api-key:<AgriFortressDid>` for Ryan's
session too, matching where the key was actually sealed.

### QuickBooks configure route (`connector-oauth-routes.ts` / `connector.ts`)

`createConfigureHandler` needs an optional `resolveConfigDid`-style parameter
(the same shape already used by `createConnectHandler` /
`createCallbackHandler`, see `resolveConfigDidFromAppAuth`) so `storeConfig`
seals under the app owner's DID when app-auth is present. Separately (and
regardless of the above), replace the peek-then-insert in `sealAndStoreV2`
with an atomic upsert on `uniq_vault_delegation_active` so an existing active
grant is always superseded rather than colliding.

### Re-consent detection (app-side)

The integrity app should compare the scopes on its current app token against
the scopes it actually depends on, and transparently redirect the user
through `/auth/authorize` when a dependency (e.g. `infer:provide`) is absent,
rather than letting a stale grant surface as a raw 403 from the capture
route. No kernel change needed — `AppAuthContext.scopes`
(`packages/auth/src/require-app-auth.ts:4-10`) already carries what the app
needs to detect the gap.

## Quick vs. Proper (Aug 17 XPRIZE deadline)

**Quick (ships for the deadline):** don't touch the shared route factories at
all. Have the integrity app's connector pages resolve against a configured
app-owner DID directly — an env var (`AGRIFORTRESS_OWNER_DID`) or a small API
call the app makes to look up its own `registry.apps.ownerDid` — and send
that DID explicitly (e.g. as `X-Acting-For`) on every Gemini/QuickBooks
connector call it makes on AgriFortress's behalf. No kernel deploy required;
the existing `X-Acting-For` delegation path in `requireAuth`
(`packages/auth/src/require-auth.ts:215-230`) already grants this today via
`validateActingAs`, provided AgriFortress has registered the app as an
authorized `agent` controller. This is a targeted, low-risk workaround scoped
to one app.

**Proper (the real fix, follow-up after the deadline):** give
`scope-manifest-route.ts`, `connector-token-route.ts`, and
`connector-oauth-routes.ts`'s `createConfigureHandler` native app-context
resolution, as described above, so every current and future connector gets
app-owner-DID support automatically instead of every app having to route
around it with acting-for headers. This is the change that actually closes
the architectural gap platform-wide rather than papering over it for one app.

## Summary table (corrected)

| # | Symptom | Corrected root cause | Fix location | Scope vocab change |
|---|---|---|---|---|
| 1 | Gemini "Status unavailable" | Tier 1 grant gap was real but has been fixed; card still resolves `ownerDid` as the logged-in user instead of the app owner whose key is actually sealed | Kernel: `scope-manifest-route.ts` + `connector-token-route.ts` app-context resolution | No |
| 2 | Voice Note 403 on `infer:provide` | Scope was already correctly requested/registered; the user's existing consent attestation predates it and needs re-issuing | Data: re-consent for affected users; App: detect stale scopes and auto-redirect to re-authorize | No — scope already correct |
| 3 | QuickBooks `connect_error` (duplicate key) | Ryan's stale personal connection was a real but separate bug (fixed); the current blocker is the configure route sealing under an inconsistently-resolved DID and a non-atomic supersede-then-insert colliding with AgriFortress's existing active grant | Kernel: `createConfigureHandler` app-context resolution + atomic upsert in `sealAndStoreV2` | No |
