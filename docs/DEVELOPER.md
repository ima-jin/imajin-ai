# Developer Guide

Getting started with the imajin-ai monorepo.

## Prerequisites

- **Node.js 22+** (use [nvm](https://github.com/nvm-sh/nvm))
- **pnpm** (`npm install -g pnpm`)
- **PostgreSQL** (local install or SSH tunnel to server)

## Quickstart (Local Dev from Zero)

The setup script handles everything automatically:

```bash
# 1. Clone
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai

# 2. Run setup (checks prereqs, installs deps, creates DB, writes .env.local files, runs migrations)
bash scripts/setup-local.sh

# 3. Start kernel
pnpm --filter @imajin/kernel dev    # http://localhost:3000

# 4. Register at http://localhost:3000/register
#    SAVE YOUR KEY FILE — it's your only copy.
```

The script accepts options for non-default Postgres connections:

```bash
bash scripts/setup-local.sh --db-user=postgres --db-host=localhost --db-port=5432
```

Run with `--help` for all options. Use `--force` to regenerate `.env.local` files (rotates all secrets).

**What the script does:**
- Checks Node.js 22+, pnpm, and PostgreSQL tools
- Runs `pnpm install`
- Creates the `imajin_dev` database (skip if it already exists)
- Generates an Ed25519 keypair (`AUTH_PRIVATE_KEY`) and all internal API keys
- Writes the kernel's `.env.local` with local service URLs pointing to the consolidated kernel at `:3000`. All extracted verticals are set up separately in their own repos: [ima-jin/events](https://github.com/ima-jin/events) (#2517), [ima-jin/links](https://github.com/ima-jin/links), [ima-jin/learn](https://github.com/ima-jin/learn), [ima-jin/coffee](https://github.com/ima-jin/coffee), [ima-jin/market](https://github.com/ima-jin/market) and [ima-jin/dykil](https://github.com/ima-jin/dykil).
- Runs all migrations via `./scripts/migrate.sh`

### Minimum Services for Local Dev

You don't need to run all apps. Start with what you need:

| Service | Port | Why |
|---------|------|-----|
| **kernel** | 3000 | Required — auth, identity, profile, registry, and all core platform services |

Add userspace apps as needed from their standalone repositories. For events, follow [its owned README](https://github.com/ima-jin/events/blob/main/README.md); it is not a workspace filter target here. Its existing ports (3006 dev / 7006 prod) and `/events` routing prefix are unchanged.

### Fresh Start (Reset Everything)

```bash
dropdb imajin_dev && createdb imajin_dev
# Then re-run step 7 above
./scripts/migrate.sh
```

## Setup (Detailed)

```bash
# Clone
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai

# Install all dependencies
pnpm install
```

## Database

### Option A: Local Postgres (recommended for external devs)

Create a database and set `DATABASE_URL` in each service's `.env.local`:

```bash
createdb imajin_dev
```

Run all migrations (each service owns its own Postgres schema):

```bash
./scripts/migrate.sh
```

> **Note:** Tables live in named schemas (`auth`, `profile`, `chat`, etc.) — not in `public`. If your DB browser shows no tables, check the schema dropdown.
>
> **⚠️ Never use `drizzle-kit push`.** It applies schema changes directly without tracking, which breaks `migrate.sh` for everyone else. Always use migration files.

### Option B: SSH Tunnel (team members)

Connect to the server's Postgres:

```bash
ssh -f -N -L 5432:127.0.0.1:5432 jin@192.168.1.193
```

Then use `postgresql://imajin_dev:PASSWORD@localhost:5432/imajin_dev` in your `.env.local`. Schemas are already pushed.

## Environment Variables

Each app needs a `.env.local` file. Start from the example:

```bash
cp apps/kernel/.env.example apps/kernel/.env.local
# Edit with your DATABASE_URL and secrets
```

### Critical Variables

| Variable | Where | What | How to Generate |
|----------|-------|------|-----------------|
| `DATABASE_URL` | All services | Postgres connection | Your local Postgres URL |
| `AUTH_PRIVATE_KEY` | kernel only | Ed25519 node signing/custody key | Local setup script; production uses the operator's existing secure provisioning |
| `NEXT_PUBLIC_DISABLE_INVITE_GATE` | kernel only | Skip invite codes in dev | Set to `true` for local dev only |
| `NEXT_PUBLIC_SERVICE_PREFIX` | All services | URL pattern for cross-service links | `http://localhost:` for local dev |
### App secrets and import ordering (#2821)

Registered apps can declare names/kinds in `imajin.app.json`: generated
`random-32B`/`random-64B` or `operator-supplied` for existing/external strings.
Never put values in that manifest. Operator values go through the masked `/jin`
set/rotate input and a separate verified human countersign. Sealed pending
staging is not an active credential; responses, approval cards and diagnostics
must not echo submitted values or underlying provider messages.

For an already-claimed app, manifest sync now appends **declaration slots only**
([#3124](https://github.com/ima-jin/imajin-ai/pull/3124)). It preserves identity,
keys and claims; removals, kind changes and non-secret changes are not applied.
After the sync countersignature, random kinds require a separate signed
**Generate** action (never for prior/revoked grant history); operator-supplied
slots require masked **Set** and its own countersignature. Sync alone neither
generates nor grants a value. See the [operator steps](app-self-secrets-operator.md).

For runtime adoption, establish the app bootstrap keystore with
`loadAppSigningKey()`, then use `createVaultBoot<Config>({ vault, configure })`
from the released `@ima-jin/auth-client`. Keep its instance in a server-only
config module. `boot.start(callback)` loads credentials into typed in-memory
configuration **before** the callback dynamically imports/starts the server.
DB modules evaluated during that import read `boot.getConfig().DATABASE_URL`;
refactor existing env-reading consumers instead of assigning secrets to
`process.env`. An eager static DB/server import still initializes too early.
The complete example and regression command are in the
[app author guide](app-self-secrets-author.md#pre-import-boot-boundary-for-database-consumers).

Start follow-up adoption with events/coffee/learn/market/links `DATABASE_URL`,
then use the [full adoption inventory](app-self-secrets-author.md#adoption-order-follow-up-work-not-an-automatic-cutover)
for the remaining app/environment keys. Coffee `WEBHOOK_SECRET` is vestigial
and excluded. This feature does not migrate standalone repositories or change
server/env/deploy files. Approvals do not restart apps: coordinate the next
restart and session invalidation when rotating `SESSION_SECRET`. #2260 remains
separate. Feature PRs never bump package versions; consume the helper through
the normal reviewed Release workflow, with no promised hard-coded version.

### Service URL Pattern

The `.env.example` files default to `NEXT_PUBLIC_SERVICE_PREFIX=http://localhost:` which uses the canonical port map for cross-service browser links. No CORS issues, no hitting production by accident.

Service-to-service URLs use kernel paths, for example
`AUTH_SERVICE_URL=http://localhost:3000/auth` and
`PAY_SERVICE_URL=http://localhost:3000/pay`. Corpus is a separate HTTP daemon:
`CORPUS_SERVICE_URL` must reach its actual host/port. Do not configure removed
split-service ports as kernel upstreams.

## Running Services

```bash
# Run a single service in dev mode
pnpm --filter @imajin/kernel dev       # localhost:3000

# Build a service
pnpm --filter @imajin/kernel build

# Build all
pnpm build
```

### Port Assignments

See [ENVIRONMENTS.md](./ENVIRONMENTS.md) for the full port table. The convention:

- `3xxx` = dev, `7xxx` = prod
- `x000-x099` = core platform
- `x100-x199` = imajin apps
- `x400-x499` = client apps

## Interactive Runs on /jin (#2404)

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

The wire fixtures follow
[plugin #77](https://github.com/ima-jin/openclaw-imajin-plugin/issues/77) and
its [command documentation](https://github.com/ima-jin/openclaw-imajin-plugin/blob/issue-77-loop-addressed-sessions/docs/session-commands.md).
With the kernel development server running, open `/dev/runs-preview` to drive
the real Runs components and shared approval controller at phone width. The
fixture generates keys in memory, verifies both command signatures, and delays
signed outcomes until after transport acceptance. It never writes browser
credentials. The preview route and its mock transport refuse production use.
A fixture preview is not evidence of a live gateway round-trip: that check
remains pending the separately implemented plugin #77. Do not disable signature
checks or change server/environment settings to make a preview appear live.


### Runs horizon (#2880)

Above Threads, the Runs lane reads each loaded loop's existing horizon projection
and refreshes it every five seconds, without a page reload. Head, near, middle,
tail and past are projection zones, not UI deductions. The depth counter is
`N / 12`; a short horizon is an explicit, non-error state. Loading additional
run pages also includes their horizons. Past retains open release/deployment
conditions until the signed projection actually exits the step. An absent
OUTCOME is never synthesized from intention or thread summary (#2931).

**Sign & claim** sends a `session.send` request through the same full-body
operator countersignature as the composer. It requests the named step's lease
from the verified serving agent; it does not write the projection or claim a
lease locally. Delivery is not acquisition: only a subsequent projected lease
moves the item to head. Stale reads or missing command authority disable claims.

`/dev/runs-preview` includes twelve steps passed through the real horizon
projector. The fixture agent observes claim requests after transport acceptance;
this demonstrates polling and grouping, not a live plugin/gateway round trip.

## Shared Packages

Code shared across services lives in `packages/`:

| Package | What it does |
|---------|-------------|
| `@imajin/auth` | Ed25519 signing, DIDs, identity |
| `@imajin/db` | Database (postgres-js + drizzle-orm) |
| `@imajin/ui` | Shared React components (NavBar, Footer) |
| `@imajin/input` | Input widgets (emoji, voice, GPS, upload) |
| `@imajin/media` | Media browser components |
| `@imajin/fair` | .fair attribution standard |
| `@imajin/onboard` | `<OnboardGate>` — anonymous → soft DID onboarding |
| `@imajin/email` | Email sending (SendGrid), templates, QR codes |
| `@imajin/trust-graph` | Trust graph queries for connection checks |
| `@imajin/config` | Shared configuration |

This is a selected list; the root README generates the complete package inventory.
`@imajin/llm` now uses AI SDK 5, provider SDK 2 and Zod 4 (#3099):
tools declare `inputSchema`, and streamed tool-call arguments are `input`.
Do not reuse older AI SDK 4 `parameters`/`args` examples.

### When shared packages change

If you edit a shared package (e.g., `@imajin/ui`), the consuming app may not pick it up due to Next.js incremental build caching.

Fix: delete the build cache and rebuild:

```bash
cd apps/kernel
rm -rf .next
pnpm build
```

### Publishing a shared package to npm

Some `packages/*` are also published to npm under the `@ima-jin` scope for external consumption (`imajin-cli`, `fixready`, `karaoke`, etc.) — see the [npm publish epic](https://github.com/ima-jin/imajin-ai/issues/1573). If you're normalizing another package for publication, read [`docs/npm-publishing.md`](./npm-publishing.md) first — it covers the in-repo/published-scope mechanism and several gotchas (RSC `'use client'` bundling, tarball leakage, CI wiring) that are easy to miss.

## Database Schemas

Each service owns a Postgres schema within the shared database. They don't share tables — only the database.

| Schema | Service | Key tables |
|--------|---------|-----------|
| `auth` | kernel | identities, sessions, challenges |
| `profile` | kernel | profiles |
| `notify` | kernel | notifications, preferences |
| `chat` | kernel | conversations, messages |
| `connections` | kernel | connections |
| `media` | kernel | assets, folders |
| `pay` | kernel | payments, balances |
| `registry` | kernel | nodes, heartbeats |
| `kernel` | kernel | loops, loop_events, surface_lease (signed warn-only surface holders; migration `0194_surface_lease.sql`) |
| `events` | [standalone events](https://github.com/ima-jin/events) | events, tickets (historical migrations remain unchanged in the kernel repo; no schema/data removal in #2517) |
| `coffee` | coffee | pages, tips |
| `learn` | learn | courses, modules, lessons, enrollments, lesson_progress (app now in [ima-jin/learn](https://github.com/ima-jin/learn), #2503; schema stays here) |

### Migration Discipline

Kernel migrations are root `migrations/NNNN_description.sql`, not app-local
Drizzle journal entries. Fresh init uses the generated kernel baseline and then
all post-cut files; existing DBs verify/adopt the baseline without reinitializing.
See [MIGRATIONS.md](MIGRATIONS.md) and the [baseline runbook](../migrations/BASELINE.md).

1. Never use `drizzle-kit push` or edit an applied/archived SQL file.
2. A schema change needs matching idempotent, schema-qualified root SQL with
   `-- owner: kernel`, numbered above the fixed cut and latest active migration.
   Drizzle can scaffold SQL; move/rename its output into root `migrations/`
   and add the idempotent guards. A local journal is not the runner's authority.
3. Run `bash scripts/check-schema-migration-sync.sh origin/main`,
   `bash scripts/check-migrations.sh` and
   `node scripts/check-migration-ownership.mjs`.
4. Test the real runner twice against an isolated scratch database; the second
   run must preserve every ledger row. Production is re-baselined, never reset.
   Never delete rows to repair history. App-owned schema/migrations belong in
   each independently owned app repo.

v0.8.27 adds `0221_vault_ssh_scope.sql` above the unchanged baseline; it is not
permission to move the cut or hand-normalize the migration ledger.

## Adding a New Service

Start from [ima-jin/imajin-app-template](https://github.com/ima-jin/imajin-app-template)
in a separate repository, preserving its history. Follow its owned README and the
[registered-app contract](./REGISTRATION.md): scoped tokens, published `@ima-jin/*`
SDK packages and public kernel APIs, never kernel-internal imports or another
service's tables. Configure and build the app using its own setup/deploy scripts;
do not copy a removed monorepo app or add a workspace filter for it here.

See [ENVIRONMENTS.md](./ENVIRONMENTS.md) and [deploy/README.md](../deploy/README.md)
for kernel deployment configuration (pm2, Caddy, DNS).

## Code Patterns

### Auth

Every service validates sessions the same way — call the auth service:

```typescript
import { requireAuth, requireHardDID, getSession } from '@/lib/auth';

// In API routes — require any auth
const authResult = await requireAuth(request);
if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

// Require hard DID (keypair-based, not magic link)
const authResult = await requireHardDID(request);

// In server components
const session = await getSession();
```

### API Routes

Next.js App Router API routes in `app/api/`:

```typescript
import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/utils';

export async function GET(request: NextRequest) {
  // ...
  return jsonResponse(data);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  // ...
  return jsonResponse(created, 201);
}
```

### ID Generation

All IDs use a prefix + timestamp + random pattern:

```typescript
function generateId(prefix: string): string {
  const random = crypto.randomUUID().replace(/-/g, '').substring(0, 13);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
}

// Examples: crs_m1abc123, lsn_m1def456, enr_m1ghi789
```

## Loop session output publishers

See [the signed loop output contract](guide/loop-output.md) for the eight
`payload.output` kinds, signing, redaction, storage bounds, and private
artifact retrieval used by the plugin and `/jin` Runs. This uses the existing
database and auth configuration; no new environment variables are required.

## Incurred-only cost reports (#2972)

The cost report is **our meter**, not an invoice reader. Ryan's 2026-10-19 ruling
keeps `usage.incurred` separate from `usage.billed`: this feature adds no billed
readers, balance polling, receipt ingestion or changes to `usage-billed-ingest`.
Compare the meter report with vendor invoices by hand for the same UTC period.
Discover the contract at `/usage/api/spec` (`apps/kernel/api-spec/usage.yaml`).

The existing authenticated `GET /usage/api/summary` accepts:
- Paired `budgetSince` and `budgetCap`, for example
  `?budgetSince=2026-10-19T16:13:00Z&budgetCap=4000USD`, for weekly incurred
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

**Warp:** the existing run-watch lifecycle meters terminal run observations,
including orchestration children without environments. It tabulates reported
inference, compute and platform credits using the existing admin config key
`usage.warp.credit-rate`, default `{ "usd": 100, "credits": 6500 }`.
The original conversion rate is stored in each incurred line's `pricing.creditRate`;
`pricing.credits` retains exact cumulative credits beyond the quantity column's
six-decimal precision. Re-observation
is idempotent by run ID; resumed cumulative growth updates the same line at
its original rate and creation timestamp. Pre-2026-10-19 run backfill remains
out of scope. It uses the existing run authority
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
explicit-cost contract is unchanged. `/jin` Spend UI work remains #2725.
## Testing
For org-tagged connection suspension (#3167), `/auth/members` shows the external
connections panel while acting as an org. The session-only
`GET/POST /auth/api/org-connections` rechecks live owner/admin role and auth access.
The real-SQL acceptance tests live in `external-mcp.integration.test.ts` and cover
both call paths, unchanged custody, removal/re-add, and service policies covering
future connections. Only `authorizeMemberConnection` enforces suspension.
With the development kernel running, `/dev/org-connections-preview` renders the
real panel with labeled fixture transport, including simulated non-admin 403.
It is unavailable outside development and never creates an authenticated session.
Browser evidence from that page proves UI rendering, not live authorization.

The full agent suite is `pnpm --silent test:agent`; while iterating, pass only
affected test files. SSH certificate/deploy tests require OpenSSH client
(`ssh-keygen`) and Python 3; CI installs both. The credential-free
`vault-ssh-dry-run.yml` checks the action without GitHub OIDC permission or host
access. See the [consumer/runner contract](deploy/vault-ssh-deploy.md).

### Sealed bank-details API (#3075)

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

### Corpus integration (#3089, #3090)

Read the [corpus-owned runbook](../apps/corpus/README.md) before loading sources.
GitHub partitions use their registry-resolved owner group DID; workspace sources
remain principal-owned. Live owner-issued grants are mandatory; membership or
stub creation is not a grant. Choose that owner's GitHub OAuth connector on
`/auth/corpus`; credentials are resolved from the kernel vault per operation,
never from `GITHUB_TOKEN`, `GH_TOKEN` or a `gh` CLI file. The one-shot owner
migration retains source rows and original signatures; it is not automatic on
deploy and must not be inferred to have run in production.

### Legal-entity settings (#3071)

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
(#1208), retains the asset row as deleted and retains change attestations and
Lore history. Generic media mutation/read permissions cannot open the source.

### Organization document agreements (#2998)

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

Document APIs require a user session cookie. The previous kernel-local document
middleware was cookie-only too; bearer-only credentials were not supported.
The repository and sibling-checkout consumer audit found only browser document
clients using the session cookie, not bearer-token callers. Agent/app bearer
support would require a separately scoped contract rather than a silent fallback.

Document signature payloads bind **only** `{did, document_hash}`. They do not bind
a request id, title, counterparty list or amendment reference. Two requests with
identical file bytes and the same DID can reuse that proof without any hash
collision; a token is evidence of the content, not independent request-specific
consent. Each submission still checks the authenticated effective identity,
current act-as authority and that request's pending signer row. This release
does not change the existing signing wire format or claim request-bound proof.

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

## Linting

Run lint across all packages:

```bash
pnpm lint
```

Config lives in `eslint.config.mjs` at the repo root — a single flat config that applies glob-based rules across all apps and packages. No per-package `.eslintrc.*` files.

**Stack:** ESLint v9 flat config, `typescript-eslint` v8, `eslint-plugin-sonarjs` v2.

All apps use Next.js rules via `FlatCompat` (bridging `eslint-config-next@14` until a Next.js 15 upgrade). All TypeScript files get `@typescript-eslint/recommended`. `packages/eslint-config-imajin` exports reusable flat config arrays for standalone package use.

### SonarJS rules

Two Sonar rules are active repo-wide via `eslint-plugin-sonarjs` v2:

| Rule | Sonar ID | Threshold | Severity |
|------|----------|-----------|----------|
| `sonarjs/cognitive-complexity` | S3776 | 15 | `warn` |
| `sonarjs/no-nested-functions` | S2004 | 4 levels | `warn` |

Both are set to `warn` (visible, non-blocking). They will be promoted to `error` once the SonarCloud cleanup epic (#1466) is closed and the existing violations are cleared.

The same rules run in SonarCloud via its GitHub App. Catching them in ESLint first means you see S3776/S2004 feedback before pushing a PR.

### Adding a rule repo-wide

Edit `eslint.config.mjs` in the repo root. All packages pick it up automatically on the next lint run.

## Typechecking

Run `pnpm typecheck`; it builds type deps first (`build:types`) so workspace packages resolve via `dist/` the same way CI does. If you've already built, `pnpm typecheck:only` skips the rebuild.

## Troubleshooting

### "Module not found" for shared packages

Run `pnpm install` from the repo root. Workspace dependencies resolve via pnpm's workspace protocol.

### Changes not appearing after build

The build cache may be stale. Delete `.next` and rebuild:

```bash
rm -rf apps/SERVICE/.next
pnpm --filter @imajin/SERVICE build
```

### Database connection errors

If developing locally, ensure your SSH tunnel is running:

```bash
ssh -f -N -L 5432:127.0.0.1:5432 jin@192.168.1.193
```

### Build fails with "DATABASE_URL not set"

Some services need DATABASE_URL at build time (for drizzle schema imports). Set a dummy value:

```bash
DATABASE_URL="postgresql://x:x@localhost:5432/x" pnpm --filter @imajin/SERVICE build
```

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
