# Contributor development guide

This guide sets up the kernel monorepo for contributors. Public integrations use
[the developer integration guide](developer-guide.md) and
[registered-app contract](REGISTRATION.md); public copy comes from
[positioning](POSITIONING.md). Imajin is alpha, not an unattended self-serve
service. Local source setup is not evidence of production readiness.

## Prerequisites and isolated workspace

Use Node.js 22 or newer, the pnpm release pinned in root `package.json`, Bash and
PostgreSQL client tools with access to an isolated development database. Windows
contributors need a compatible Bash environment for repository scripts. Some
crypto/deploy tests also require OpenSSH clients and Python.

Work in a dedicated git worktree for changes, not the shared main checkout.
Install from the lockfile without editing package versions:

```bash
pnpm install --frozen-lockfile --loglevel=error
bash scripts/setup-local.sh --help
```

## Local setup

For a new isolated development environment:

```bash
bash scripts/setup-local.sh
pnpm --filter @imajin/kernel dev
```

The setup script checks prerequisites, installs dependencies, creates the selected
development database if absent, writes local configuration, runs migrations,
builds type dependencies and provisions service bootstrap identities. It sets
kernel service URLs to `http://localhost:3000` and enables the local invite-gate
bypass. Register a local identity at `/register` and protect its key file.
This is local development, not the public alpha sign-up path.

Options include `--db-user`, `--db-host`, `--db-port`, `--db-name`,
`--skip-install` and `--skip-migrate`. Existing env files are preserved unless
`--force` is chosen. Do not use force as a routine repair: it regenerates local
secrets and can invalidate existing custody. Never reset a shared database or
copy production credentials into local setup.

Only the kernel is required for a minimal workspace. Events, coffee, dykil,
links, learn and market are separate `ima-jin` repositories; follow their own
setup/build/deploy runbooks rather than adding workspace filter targets here.
Corpus is a separate internal HTTP daemon with its own store/runbook.

## Configuration and credentials

`apps/kernel/.env.example` describes the required names and safe defaults;
`.env.local` is untracked and protected. `DATABASE_URL` must target development.
`AUTH_PRIVATE_KEY` is the node's signing and custody root, not a user key.
`APP_URL` is the runtime public origin for redirects. Browser-visible
`NEXT_PUBLIC_*` values must contain no secrets. Service URLs point to the
consolidated kernel's prefixes, not removed split-service processes.

Use the vault provisioning controls for vault-only internal credentials.
`ATTESTATION_INTERNAL_API_KEY` and the cron secret are not hand-set shared env
keys. Service bootstrap identities are purpose-bound and granted explicitly;
missing/half-written configuration fails rather than silently replacing identity.
Read [ENVIRONMENTS.md](ENVIRONMENTS.md) for check-env annotations, independent
dev/prod vault paths and deployment-target validation.

Registered apps declare secret names/kinds only. Manifest sync creates slots,
not usable values; generation or masked Set has a separate signed approval.
Use `loadAppSigningKey()` and `createVaultBoot` from the published auth-client
SDK, installing typed server-only configuration before dynamic DB/server imports.
Do not assign fetched values to `process.env`. See
[app author boot ordering](app-self-secrets-author.md#pre-import-boot-boundary-for-database-consumers).
Adoption and restart are per app/environment; SDK support does not migrate a host.

## Database and migrations

The kernel owns its service schemas. Independently deployed apps own theirs,
even when on the same database server. No runtime cross-owner SQL or internal
package import substitutes for the owning service's API.

Fresh kernel initialization uses the generated baseline plus post-cut root SQL.
Existing databases verify/adopt the baseline without being reset. Follow
[MIGRATIONS.md](MIGRATIONS.md), [ownership](../migrations/OWNERSHIP.md) and
[the baseline runbook](../migrations/BASELINE.md).

A schema edit requires an idempotent, schema-qualified root migration with
`-- owner: kernel`, a free active number, and ownership-map entries for new
objects. Never edit applied/archived migrations, use `drizzle-kit push`, move the
baseline cut or delete migration rows. Test the runner twice on a scratch DB.

```bash
bash scripts/check-schema-migration-sync.sh origin/main
bash scripts/check-migrations.sh
node scripts/check-migration-ownership.mjs
```

CI also checks number collisions against moving main. An unchanged schema needs
no migration; a docs change must not alter schema to make an example look true.

## Authentication and acting identity

Kernel routes use the canonical authentication helpers and service-specific
policy, not caller-supplied identity fields. A signed-in human may select a
business/org with `x-acting-as`; derive ownership, names, handles, labels and
defaults from verified `resolveActingDid`/`actingAs`, not `session.handle` or the
raw personal DID. Recheck live membership, role and allowed services. A denied
org operation must not fall back to personal authority.

Test personal and acting-as-org contexts, including non-admin, disallowed-service,
revoked grant, malformed selector and unauthenticated refusals for any changed
boundary. An agent authenticates as itself; assignment is not universal capability.
Human confirmation rails can deliberately reject act-as entirely: preserve that
self-only exception rather than applying org ownership semantics to countersigning.

External apps use the published auth-client and registered public contracts.
Begin login at the app so it owns callback state, exchange the single-use code
with app key proof, and trust the kernel-returned subject. Cookie, delegated app
and app-service token paths are different authority lanes, never interchangeable
fallbacks. See the live [auth spec](https://jin.imajin.ai/auth/api/spec).

## Interactive Runs on /jin

The Runs lane uses the existing principal-scoped loop registry, not a harness
API. Threads are a lineage tree; Blocked-on-you combines blocked loops and the
same pending approval cards shown in the operator Inbox. Opening a thread shows
typed signed events, a composer, stop and child-spawn controls. A surface
collision warns on both threads without preventing commands.

`POST /jin/api/runs/{loopId}/commands` prepares a short-lived command with
`action: "prepare"`, `type: "session.send" | "session.abort" | "session.spawn"`
or `session.archive|reset|label|history` and a bounded `payload`.
The target is `payload.loopId` (send/stop/lifecycle) or
`payload.parentLoopId` (spawn); spawn also accepts task, label, group and model.
The server resolves the verified originating agent, not a client-selected DID.
After signing the complete prepared command in the browser, the operator
submits it with `action: "dispatch"` and `command`. The principal's private key
never leaves the browser. A missing key, stale grant, revoked binding, ended
loop or ambiguous publisher fails closed.

Both Ed25519 signatures cover the identical canonical object:
`{type, commandId, to, principal, issuer, issuedAt, expiresAt, payload}`.
The kernel grant and principal wish are checked before the durable correlation
record is claimed and the command is sent only to the target agent's own DID
socket. Delegated notification sockets are not command recipients. Registry
`refs` remain opaque: no session keys are read or forwarded, no gateway RPC is
made, and no transcript is fetched.

Native approval cards acquire a thread association only from a verified
`loop.approval.bound` signed envelope binding
`{loopId, principalDid, agentDid, approvalId}`. Approve/deny still uses
`POST /jin/api/operator-approvals/{proposalId}/decision` and the existing
approval service, with a separate full-command wish. A converted proposal
selects one execution rail atomically and suppresses the legacy executable
`operator.approval.decided` fan-out. An unavailable wish must never silently
fall back to that legacy rail.

Command correlation, signed bindings and outcomes reuse `kernel.loop_events`;
this feature needs no new schema. A socket send means only delivery attempted.
The UI waits for the correlated agent-signed
`loop.session.{send,approve,deny,abort,spawn,archive,reset,label,history}.{completed,failed}` observation.
The kernel verifies the authenticated socket DID, current agent key, principal,
command ID, command type and payload hash before recording an outcome. Spawn
lineage is accepted only from the signed child/parent attestation.
The existing outbound plugin WebSocket forwards only authenticated
`loop.approval.bound` and command-result frames to
`POST /jin/api/internal/session-events`. Its `socketDid` comes from socket
authentication, not the frame. The internal API key protects this in-process
handoff; the agent signature is still independently required. Outbound commands
use the local `/chat/api/internal/session-command` transport, deliberately
separate from notification fan-out and its delegated recipients. Neither
internal endpoint is a harness RPC or a public command bypass.

Opening an active, commandable thread sends one full-body-signed
`session.history` wish. Only the plugin reads its local history: at most
20 recent entries, 80 redacted text/tool-call/tool-result output blocks and
12 KiB per output, delivered through the existing signed `loop.progress`
path. Stored history remains readable when signing or delivery is unavailable.
Session controls send exactly `{loopId}` for archive/reset/history or
`{loopId,label}` for label (nonblank, at most 256 characters). Unknown payload
fields are refused both before signing and at dispatch. Prepare emits an
explicit five-minute expiry; omitted/null expiry is canonicalized as null
for both signatures and uses the same default TTL at verification.

Archive hides only a signed `archived` lifecycle projection from active
Threads; the loaded Archived run history disclosure reopens its retained
events. Neither delivery nor a button click mutates a registry projection.
Labels arrive through signed inventory updates, never an optimistic rename.
Reset displays the plugin's signed `missing_scope` refusal with its command ID
and issuer in History. No plugin scopes, local session references, transcript
access, or Gateway client are added.

The development `/dev/runs-preview` uses labelled fixture transport with the
real Runs components and shared approval controller. It verifies both signatures
and delays signed outcomes until transport acceptance. It refuses production
use and never writes browser credentials; it is not a live gateway proof. The
publisher's [session-command contract](https://github.com/ima-jin/openclaw-imajin-plugin/blob/main/docs/session-commands.md)
owns its end of the wire.

### Runs horizon

Above Threads, the Runs lane reads each loaded loop's existing horizon projection
and refreshes it every five seconds, without a page reload. Head, near, middle,
tail and past are projection zones, not UI deductions. The depth counter is
`N / 12`; a short horizon is an explicit, non-error state. Loading additional
run pages also includes their horizons. Past retains open release/deployment
conditions until the signed projection actually exits the step. An absent
OUTCOME is never synthesized from intention or thread summary.

**Sign & claim** sends a `session.send` request through the same full-body
operator countersignature as the composer. It requests the named step's lease
from the verified serving agent; it does not write the projection or claim a
lease locally. Delivery is not acquisition: only a subsequent projected lease
moves the item to head. Stale reads or missing command authority disable claims.

`/dev/runs-preview` includes twelve steps passed through the real horizon
projector. The fixture agent observes claim requests after transport acceptance;
this demonstrates polling and grouping, not a live plugin/gateway round trip.


## Incurred-only cost reports

The cost report is **our meter**, not an invoice reader. It keeps `usage.incurred` separate from `usage.billed`: incurred reports do not add billed readers, balance polling or receipt ingestion.
Compare the meter report with vendor invoices by hand for the same UTC period.
Discover the contract at `/usage/api/spec` (`apps/kernel/api-spec/usage.yaml`).

The existing authenticated `GET /usage/api/summary` accepts:
- Paired `budgetSince` and `budgetCap`, for example
  `?budgetSince=<UTC-start>&budgetCap=4000USD`, for weekly incurred
  totals by provider, cumulative spend, remaining cap and a straight-line
  trailing-seven-day projection.
- Paired `from` and `to` UTC dates (`YYYY-MM-DD`) or timezone-bearing timestamps
  for an independent date-range cost report: `from` is inclusive and `to`
  exclusive. An open period may end in the future; `asOf` makes the current
  observation cutoff explicit. These bounds do not change the legacy `window`
  summary or the budget's own interval.

Both new views use `usage.incurred.created_at` and `cost_usd`, exclude failed
upstream attempts, and expose unpriced-row counts. Missing cost is not proof
of free usage; calls made outside kernel-observed/metered paths are not captured.
The cap is USD-only. The legacy incurred/billed/drift response remains separate
and backwards-compatible; neither new view imports invoices into the meter.

**Warp:** the run-watch lifecycle meters terminal run observations,
including orchestration children without environments. It tabulates reported
inference, compute and platform credits using the existing admin config key
`usage.warp.credit-rate`, default `{ "usd": 100, "credits": 6500 }`.
The original conversion rate is stored in each incurred line's `pricing.creditRate`;
`pricing.credits` retains exact cumulative credits beyond the quantity column's
six-decimal precision. Re-observation
is idempotent by run ID; resumed cumulative growth updates the same line at
its original rate and creation timestamp. No general historical run backfill is implied. It uses the existing run authority
and records, not a new billing credential or a key-wide vendor billing pull.
Missing terminal usage creates an unpriced line and can later be upgraded at
its stored rate; an unknown observation never erases a known cost. The existing
run-watch sweep replays durable terminal records to retry failed meter writes,
then lifecycle-reads descendants of known kernel dispatches after normal
in-flight work. Root API reads stop once the root has metered credits and its
latest terminal observation is older than 24 hours, unless newer dispatch/resume
activity reopens it. Unpriced roots keep retrying, and terminal-record replay
remains DB-only and unchanged. Recovery follows the existing 14-day event-log retention;
incurred rows themselves persist independently.
Use the canonical `adapter:warp` source/run-ID convention for any external
Warp emitter to avoid reporting the same run twice.

**Anthropic and Kimi/Moonshot:** the existing inference passthrough records
tokens and computes cost from `src/lib/inference/pricing.ts`. The principal's
normal sealed inference connector and `anthropic:infer` / `moonshot:infer`
grant are sufficient; no billing/admin grant is required for this report.
Unknown models use the explicitly estimated connector fallback rate; missing
token counts stay unpriced. Moonshot JSON and SSE use our rate card, never an
upstream `usage.cost` or account balance. The existing OpenRouter-specific
explicit-cost contract is unchanged.

## Private-record consumers

### Sealed bank-details API

`GET/PUT/DELETE /auth/api/bank-details` requires a human session and the same
auth-scoped organization owner/admin authorization as legal-entity editing.
`PUT` validates a full replacement `bank-details:v1` record. Each financial
identifier is sealed separately; the immutable private media document and
metadata carry only references/non-secret fields and per-field visibility.
Generic media mutation or vault fetch cannot open this record.

The trusted `readBankDetails(ownerDid)` helper returns non-secret metadata,
visibility and `hasRail` without unsealing; external consumers must apply the
visibility policy. Save/revoke retains documents, signed create/revoke evidence
and superseded grant history. This is node-delegated Tier 0 custody, **not
zero-custody**; Tier 1 saves fail closed. Bank settings UI and invoice/PDF
disclosure are separate work. Fetch `/auth/api/spec` for validation and errors.

### Corpus integration

Read the [corpus-owned runbook](../apps/corpus/README.md) before loading sources.
GitHub partitions use their registry-resolved owner group DID; workspace sources
remain principal-owned. Live owner-issued grants are mandatory; membership or
stub creation is not a grant. Choose that owner's GitHub OAuth connector on
`/auth/corpus`; credentials are resolved from the kernel vault per operation,
never from `GITHUB_TOKEN`, `GH_TOKEN` or a `gh` CLI file. The one-shot owner
migration retains source rows and original signatures; it is not automatic on
deploy and must not be inferred to have run in production.

### Legal-entity settings

`/auth/legal-entity` sits next to Tax and is available for both human and
business DIDs. The page and `/auth/api/legal-entity` require a human session
and the canonical auth-scoped owner/admin act-as check; agents, app tokens,
ordinary members and disallowed service selections cannot edit or read its
complete private record.

The conventional source is
`{MEDIA_ROOT}/{sanitized-DID}/assets/legal-entity.md`, with a
`{assetId}.fair.json` sidecar, so revoke/recreate retains the old asset's mirror.
It uses the existing YAML frontmatter and
release header: UI `public` is header `silent`, plus `on-consent` and `never`.
The signature binds both values and policy through the document's SHA-256
integrity hash. It is node-witnessed on behalf of the authenticated owner,
not proof that the owner signed with a device-held DID key.

Use `getLegalEntity(did, viewerDid)` for consumer reads. Missing, revoked,
malformed or unverifiable sources return `null`; unreleased fields are absent,
including `never` for the owner. On-consent fields require a current raw-mode
broker grant for purpose `legal-entity.disclosure`, scoped to the exact field
(`legalName`, `operatingName`, or `address.line1`, `address.line2`, `address.city`,
`address.region`, `address.postalCode`, `address.country`). Attestation-only
consent cannot reveal raw values. An optional release-header `viewer` further
restricts the viewer DID. No legal fields are projected anywhere.

Writes reject bad fields with HTTP 400 and cap the request and serialized
source at the existing tax-document budget (16 KiB). Fields are limited to
200 characters, country is ISO 3166-1 alpha-2, operating name/address line 2
are optional, and region/postal code may be empty for countries without them.
Tax numbers stay in `profile.tax_registrations`; this record rejects them.
Revocation writes a signed, value-free tombstone through `document.changed`
, retains the asset row as deleted and retains change attestations and
Lore history. Generic media mutation/read permissions cannot open the source.

### Organization document agreements

On `/auth/attestations`, select the organization through the existing identity
switcher, then create a document request. The form identifies the organization
name/DID as **author and first signer**, separately from the authenticated human
controller. Documents and identity signing use the canonical auth-scoped act-as
authorization; a controller whose `allowed_services` excludes `auth` is denied,
not silently switched to a personal identity. No grants are added by this flow.

The counterparty opens the request under their own account and sees the title,
organization, document and own-account sign controls. Once every unique party
has signed the exact hash, a business-DID author's registered `agreement` appears as a document card
in both parties' attestation history. Private signed copies remain separately
owned. Either party can revoke the agreement; its history, timestamps, hash and
signature records remain visible with a revoked marker rather than being deleted.
Personal and non-business group documents keep their `document.created` or
`document.amended` type on completion. Decline and amendment use the same
owner/admin and `auth` allowed-services gate as signing; amendments retain the
actual human and original reference without trusting caller-supplied provenance.

Document APIs require a user session cookie. Bearer-only agent/app support is not part of this session contract and cannot
be introduced by a silent credential fallback.

Document signature payloads bind **only** `{did, document_hash}`. They do not bind
a request id, title, counterparty list or amendment reference. Two requests with
identical file bytes and the same DID can reuse that proof without any hash
collision; a token is evidence of the content, not independent request-specific
consent. Each submission still checks the authenticated effective identity,
current act-as authority and that request's pending signer row. The signing wire format does not claim request-bound proof.

**Verify a saved document** uploads a file to
`POST /auth/api/documents/{id}/verify` as multipart `file`. The response is
`{ valid, hashMatches, signaturesValid, revoked }`. Success requires all checks
and no revocation. A changed file displays a plain mismatch/tamper failure.
Node-witnessed signatures prove the node recorded an authorized action, not
possession of the organization's or human's own DID private key. True DID-key
signatures are a distinct supported model. Discover contracts through `/spec`
and the auth OpenAPI document; `agreement` is included in registered types.

With the development kernel running, open `/dev/agreement-preview` for real
form/card/viewer components driven by clearly labelled fixture transport.
Capture at desktop and 390px width. The preview offers org/counterparty accounts,
sign/revoke controls and a matching fixture download. Upload that download to
show success; change its bytes to show tamper failure. The fixture does not
prove a live API or cryptographic round-trip. Both preview and fixture-document
routes refuse non-development use, and the transport restores on unmount.

- **End-to-end test cases:** `tests/HAPPY_PATH.md`
- **Security audit checklist:** `tests/AUDIT.md`


## Packages, build and validation

For organization connection suspension, `/auth/members` exposes the external
connections panel while acting as an org. Its session-only org-connections API
rechecks live owner/admin role and auth-service access; only
`authorizeMemberConnection` enforces suspension. The real-SQL
`external-mcp.integration.test.ts` covers both call paths, unchanged custody,
removal/re-add and policies for future connections. A development preview shows
the real panel with labelled fixture transport and a non-admin refusal, but
does not create a session or prove live authorization.

Workspace imports use `@imajin/*`; external published packages use `@ima-jin/*`.
Do not publish kernel-private modules just to make an app import work.
[npm-publishing.md](npm-publishing.md) covers exports, declaration dependencies,
React/server subpaths and tarball checks. Public descriptions stay aligned with
the canonical positioning file.

`@imajin/llm` tools use the current AI SDK `inputSchema` and streamed tool-call
`input` fields, not older `parameters`/`args` examples.

While iterating run only affected test files, including tests that read changed
docs. At the end run the full suite once. Redirect long logs to a local file and
inspect failures, rather than flooding an agent transcript:

```bash
pnpm --silent test:agent path/to/affected.test.ts
pnpm --silent test:agent
pnpm lint:agent
pnpm typecheck:agent
pnpm build:agent
```

Lint configuration is root `eslint.config.mjs`; test aliases and reporter settings
live in `vitest.config.ts`. Typecheck/build dependencies must resolve actual
workspace exports. A consuming Next build is needed for React Server Component
boundary changes; unit tests alone cannot establish that boundary.

For missing workspace modules, check the frozen install and prerequisite builds.
For stale app output, rebuild the affected app's derived cache through its owned
build procedure. For database failures, check only non-secret connection status
and the isolated DB/tunnel; never print env files or process dumps.

Deployments use reviewed release/deploy workflows with the existing production
reviewer gate. Never deploy by pulling on the production box or pushing a tag
by hand. Local tests and source configuration do not prove a host rollout.

## Email Storage Locations

Three places where user email addresses live. The notify service checks them in priority order.

| Table | Column | Set By | Purpose |
|-------|--------|--------|---------|
| `auth.identities` | `contact_email` | Stripe checkout (ticket purchase, onboard with payment) | Billing/notification email from payment flow |
| `profile.profiles` | `contact_email` | Connection invite register form | Profile-level email from registration |
| `www.contacts` + `www.subscriptions` | `email` | Register form (`optInUpdates` checked) OR website subscribe form | Mailing list / newsletter sends only |

**Notify email resolution** (`apps/kernel/app/notify/api/send/route.ts`):
1. `data.email` in the event payload (explicit, e.g. from Stripe webhook)
2. `profile.profiles.contact_email` (primary — connection invite / register flow)
3. `auth.identities.contact_email` (fallback — Stripe / ticket purchases)

`www.contacts` is **not** checked by the notify service — it's a separate broadcast/newsletter system.

**When each gets populated:**
- **Ticket purchase** → `auth.identities.contact_email` (from Stripe checkout email)
- **Connection invite register** → `profile.profiles.contact_email` + optionally `www.contacts`
- **Website subscribe form** → `www.contacts` only (no DID, no identity)
