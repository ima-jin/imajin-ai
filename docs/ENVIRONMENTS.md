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
