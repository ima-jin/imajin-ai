# Environment configuration

The kernel is one application with path-based services, not a set of independently
running auth/pay/profile servers. The recorded deployment uses Caddy and pm2;
configuration in git is not evidence that a host has been deployed or migrated.
See [deploy posture](ops/DEPLOY-POSTURE.md) and the
[deployment runbook](../deploy/README.md) before changing a host.

## Kernel, apps and internal services

`deploy/ecosystem.dev.config.js` and `deploy/ecosystem.prod.config.js` are the
version-controlled pm2 definitions. The kernel processes are `dev-jin` on port
3000 and `prod-jin` on port 7000. Their cron schedulers are separate processes.
The production file also retains obsolete split-service entries; they do not
establish live services or justify configuring those ports as kernel upstreams.

Events, coffee, dykil, links, learn and market run from independently owned
`ima-jin/<app>` repositories and use their own deployment runbooks. Do not add
them back to the kernel's workspace or ecosystem to make setup pass. Web-app port
ranges conventionally use 3xxx for dev, 7xxx for prod, x100-x199 for Imajin apps
and x400-x499 for client apps. Events retains its 3006/7006 assignment.

Corpus is an internal HTTP daemon, not a public subdomain service. Dev corpus
is recorded on the kernel host at 8013; production corpus runs on gx10 at 8003
and is absent from the kernel production ecosystem. Set `CORPUS_SERVICE_URL` to
the reachable private address; localhost is only correct when colocated. Keep
credential-bearing internal HTTP private or use TLS. Corpus owns its SQLite
store, registry-owner-DID partitioning and GitHub OAuth connector integration;
see [its runbook](../apps/corpus/README.md).

GPU services belong to [ima-jin/imajin-ml](https://github.com/ima-jin/imajin-ml),
not the kernel ecosystem. Resolve actual host/model configuration there instead
of relying on a copied LAN address or model inventory in this guide.

## Database isolation

Use a separate database and credential per environment. The recorded kernel
names are `imajin_dev` and `imajin_prod`. Standalone applications own their
schemas and may have their own databases; sharing a server does not authorize
cross-owner reads. See [migration ownership](../migrations/OWNERSHIP.md).

Set `DATABASE_URL` through protected local configuration, not source or commands
containing a password. For remote development, use an authorized SSH tunnel and
a dedicated development database. Do not point a local test runner at production.
The shared `@imajin/db` client bounds pools, acquisition and statement deadlines;
liveness probes use that same pool. Defaults and `DB_*` overrides are in the
[database deadline runbook](../deploy/README.md#database-deadlines-and-pool-stall-reproduction).

Use root SQL migrations through `scripts/migrate.mjs` or `scripts/migrate.sh`.
Never use `drizzle-kit push`, reset a deployed database or delete migration rows.
A fresh kernel uses the generated kernel baseline and post-cut files; existing
DBs adopt it through the [baseline procedure](../migrations/BASELINE.md).

## Configuration sources

Each running service owns an untracked `.env.local` and a checked-in
`.env.example`. Example files contain variable names, safe defaults and policy,
never credentials. Use environment-derived URLs, not hardcoded service hosts.

- `APP_URL` is the kernel's runtime public origin for browser redirects.
- `AUTH_SERVICE_URL`, `PAY_SERVICE_URL`, `PROFILE_SERVICE_URL` and similar server
  URLs address kernel service prefixes on the configured origin.
- `NEXT_PUBLIC_*` values are browser-visible and may be built into assets; they
  must never carry secret material. Local setup uses the consolidated kernel.
- `SESSION_COOKIE_SCOPE` defaults to host-only. Same-origin path-proxied apps
  still require the documented [cookie isolation](security/cookie-isolation.md)
  controls; a host-only cookie is not path isolation.

Registered-app integrations discover wire contracts through the owning service's
live spec, such as [auth](https://jin.imajin.ai/auth/api/spec),
[connections](https://jin.imajin.ai/connections/api/spec) or
[pay](https://jin.imajin.ai/pay/api/spec). A spec link is not authorization.

## Environment validation

`scripts/check-env.ts` runs before builds and checks `.env.local` against
`.env.example`. A missing required variable fails. A missing entire file is a
hard error for an ecosystem deploy target; an undeployed workspace is a warning.
Standalone repositories validate their configuration themselves.

Place an annotation immediately above a variable to describe its handling:

- `# optional`: absence is a grouped warning, not an error.
- `# vault-sourced: <reason>`: absence is expected; a hand-set value warns that
  it is deprecated and must be removed only after coordinated rotation/adoption.
- `# deprecated: <reason>`: absence is expected; presence warns with that reason.
- No annotation: the variable is required.

## Vault path and bootstrap

`VAULT_PATH` belongs in the pm2 ecosystem environment, not `.env.local`.
Dev uses `~/.imajin/vault.dev.json`; prod uses `~/.imajin/vault.prod.json`.
The runtime expands the leading tilde. Production refuses an unset path or a
configured missing vault; an empty production vault degrades health.

`scripts/check-vault-path-consistency.mjs` compares ecosystem, provisioning env
and the running kernel's path before deploy. A mismatch fails; a redundant
matching `.env.local` value warns. This prevents provisioning into one vault
while the kernel reads another. It reads path metadata, not vault contents.

For a genuinely new vault only, `VAULT_ALLOW_BOOTSTRAP=1` explicitly permits the
missing file and warns until the first seal creates it. Remove that permission
once the file exists. Do not enable it to silence a missing production vault.
Health reports status, path, entry count and bootstrap metadata, never values.

## Service identities and internal secrets

`provision-service-bootstrap.mjs` discovers required service bootstrap pairs from
`.env.example`, then ensures the appropriate vault grant after migrations and
before check-env. Both keys present are preserved; a half-present/empty pair
fails rather than overwriting identity. Neither key is printed.

For in-repo services use `--all` or a service name; standalone checkouts use
`--app <slug>` or `--service-dir <path>`. A standalone `.env.local` must already
exist. `--dry-run` checks configuration and imports without minting, writing,
granting or contacting the database. Production provisioning remains behind the
existing deployment reviewer gate.

Single-consumer generated internal secrets are purpose-bound, vault-held and
resolved in memory. Initial generation is automatic; replacement/revocation
needs the documented operator authority. Shared credentials need explicit grants
to each external consumer, using that consumer's existing bootstrap identity.
`ATTESTATION_INTERNAL_API_KEY` is vault-only; a hand-set env value is ignored.
A missing vault credential fails closed instead of creating a shared-key fallback.

The cron scheduler fetches purpose `kernel.cron-secret` with its
`KERNEL_CRON_VAULT_BOOTSTRAP_*` identity; there is no `CRON_SECRET` env variable.
Use the existing provisioning/rotation controls, not a copied bearer token.
For node-root or internal-secret rotation, follow the
[key roles and rotation runbook](security/node-key-roles-and-rotation.md).

## Internal-secret replacement and service bootstrap operations

A single-consumer generated secret is self-granted to the node by purpose and
resolved with `getInternalSecret`. Initial generation records metadata/hash, not
bytes. Human countersignature is needed to import, replace or revoke, not to
create the first internal value. Granting a shared value to corpus is a separate
operator action through `grantInternalSecretTo`, reusing the existing wrapped
material rather than generating a second value. Corpus resolves the current
purpose grant on each boot with its existing bootstrap identity and sends a
deferred acknowledgement on first use.

`rotateInternalSecret` keeps the purpose, replaces the self-grant and reissues
external grantees with their terms. `revokeInternalSecret` withdraws the self-grant
and its provisioning lookup together; the next lookup generates a fresh value.
External grantees are not silently changed by that revoke: re-grant or revoke
each explicitly, and heed the logged stale-grantee error. Tier 1 refuses node
self-replacement before writing. Other running processes keep cached values until
restart. These supported operations are not permission to delete DB rows by hand.

For provisioning, use plain Node's ESM entry point with the kernel's protected
env file and the intended `--env dev|prod` ecosystem. Do not invoke it through a
CommonJS-transpiling wrapper. Choose exactly one of `--all`, a service name,
`--app <slug>` or `--service-dir <path>`. `--app` resolves a one-segment slug next
to the kernel checkout; a standalone checkout must declare its required bootstrap
pair in `.env.example` and already have `.env.local`.

Optional bootstrap pairs and undeployed in-repo services without env files are
skipped. Both absent keys cause an in-process mint, identity registration and
atomic mode-0600 file installation; both present nonempty keys are preserved.
An incomplete/empty pair fails without replacement. Every existing or newly
minted pair has its required grant ensured idempotently, so a write/grant
interruption can be retried. A standalone service receives the attestation key,
never the kernel cron secret merely because of its directory name. Restart its
owned process after provisioning so it fetches the value in memory.

The output contains service, DID, existing/minted status and grant id only,
never private material. `--dry-run` validates file pairs and loads the modules a
real run uses without a database call, mint, file write or grant. Local setup
runs provisioning after migrations; normal deploy runs it before check-env and
restart, behind the existing production reviewer gate.

Cron routes return 503 with a warning when their vault secret is unavailable and
401 for the wrong bearer. A missing scheduler identity/grant fails provisioning;
repair the vault/identity, not an invented CRON_SECRET env value. Each scheduler
uses its own environment's cron grant and records its first-use acknowledgement.

The recorded standalone web-app port pairs are coffee 3100/7100, dykil 3101/7101,
links 3102/7102, learn 3103/7103 and market 3104/7104, with their corresponding
path prefixes. They remain app-repository responsibilities, not kernel workspace
entries or live-host evidence. Configuration paths and actual process ownership
must be checked against those owned runbooks before a host change.
The ecosystem also records fixready at 3400/7400 and karaoke at 3401/7401.
Their own repositories own database names, credentials and deployment; do not
treat this port convention as a shared-database access grant.

Common public settings include `NEXT_PUBLIC_DOMAIN`, `NEXT_PUBLIC_BASE_URL` and
`NEXT_PUBLIC_SERVICE_PREFIX`. `APP_URL` is an origin, not a path. `VAULT_PATH`
comes from the ecosystem environment and overrides an env-file value in pm2;
provisioning must resolve the same file. Without an explicit path in nonproduction
local development, `~/.imajin/vault.json` can bootstrap implicitly; production
requires the configured per-environment path. Health exposes only vault status,
path, entry count, last-loaded time and bootstrap state, never field names/values.

## App-owned secrets and restarts

Apps declare secret names/kinds in `imajin.app.json`. Manifest sync adds slots
only. Random values require signed Generate; existing/operator-supplied strings
need masked Set and a separate human countersignature. Pending staging is not a
grant. `createVaultBoot` loads approved values into typed server-only memory
before dynamic DB/server imports; never backfill them into `process.env`.

Adoption is per app/environment, not automatic. Do not remove a required env value
until its consumer has adopted vault boot, has approved usable material and has
passed a coordinated restart. A vault rotation does not change a provider account;
running processes retain loaded values, and rotating session secrets can log users
out. See the [author](app-self-secrets-author.md) and
[operator](app-self-secrets-operator.md) guides for adoption inventory.

Pay callers use scoped app-service tokens, not a shared pay API key. Approve
only required service scopes; pledge setup also requires the user's own session
and later charges must reference its recorded setup. Topups are pending rail
payments, not direct caller-supplied credits. Check the live pay spec.

## Deployment boundaries

Use the reviewed Release and deploy workflows, not `git pull` on a production
host. The [vault SSH action](deploy/vault-ssh-deploy.md) uses ephemeral job keys
and OIDC with separately installed host trust. The
[inference updater](../deploy/infer-passthrough/README.md) has its own protected
runtime configuration and exact-SHA production-evidence checks. Those runbooks
describe supported procedures, not proof that a particular host is configured.
