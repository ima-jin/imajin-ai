# Contributor development guide

This guide sets up the kernel monorepo for contributors. Public integrations use
[the developer integration guide](developer-guide.md) and
[registered-app contract](REGISTRATION.md); public copy comes from
[POSITIONING.md](POSITIONING.md). Imajin is alpha, not an unattended self-serve
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

## Signed loops, approvals and Runs

The kernel learns harness activity only through authenticated signed observations.
[Loop authorization, horizons, leases and receipts](loops-rail-contract.md) define
that rail. No gateway RPC, session store or transcript read belongs in kernel
integration code. Public wire schemas live in the
[Jin spec](https://jin.imajin.ai/jin/api/spec).

Runs controls send loop-addressed commands with both a kernel grant and a full
principal-signed wish. A socket send means delivery attempted; only a correlated,
verified agent outcome changes the projection. Native approval bindings are
signed, not inferred from refs. Missing command authority must not fall back to
legacy execution. Claims are warn-only surface leases, not exclusive dispatch locks.
The [loop output contract](guide/loop-output.md) covers redaction and artifacts.

Development preview pages use labelled fixture transports and refuse production
use. They can demonstrate component behavior, not a live plugin round trip,
cryptographic ownership or deployment. Never disable auth to turn a preview into
claimed acceptance evidence.

## Costs, connectors and private records

The usage summary is an incurred meter, separate from billed invoices. Date-range
reports have inclusive start/exclusive end; missing costs are unknown, not free.
Warp credit observations preserve original pricing and idempotent run correlation;
provider model costs follow the current rate card. See the
[usage spec](https://jin.imajin.ai/usage/api/spec) rather than a copied rate table.

Org-held keys are write-only. Human members need their explicit current grants;
assigned agents use verified assignment and service permission. Administrative
suspension is separate from key custody. Corpus requires owner-issued grants and
the source owner's selected OAuth connector, not a node GitHub token or CLI login.
See [connections](https://jin.imajin.ai/connections/api/spec) and
[the corpus runbook](../apps/corpus/README.md).

Bank details and legal-entity documents use dedicated session/owner-admin and
field-release controls. Generic media permissions do not reveal sealed identifiers.
Document signatures bind their documented content payload; do not claim
request-specific consent or device-key signing for node-witnessed actions.
Revocation retains records, tombstones and signed provenance. Read the
[proof model](guide/proof-model.md), [security disclosures](../SECURITY.md) and
owning API specs before changing a private-record consumer.

## Packages, build and validation

Workspace imports use `@imajin/*`; external published packages use `@ima-jin/*`.
Do not publish kernel-private modules just to make an app import work.
[npm-publishing.md](npm-publishing.md) covers exports, declaration dependencies,
React/server subpaths and tarball checks. Public descriptions stay aligned with
the canonical positioning file.

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
