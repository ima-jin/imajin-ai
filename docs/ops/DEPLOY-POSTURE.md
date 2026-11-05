# Deploy posture

This document describes the repository's deployment contracts. Workflow source proves the configured sequence, not that a host has run it. Use the Actions run, serving build, migration status and service health as evidence of a particular deployment.

## Development and production

Development deployment follows successful CI on main through [deploy-dev.yml](../../.github/workflows/deploy-dev.yml). Production deployment accepts the release tag or an explicitly selected ref through [deploy-prod.yml](../../.github/workflows/deploy-prod.yml), with the required `production` environment reviewer. Concurrency serializes each environment's deploys without cancelling an active restart.

The release path is **dispatch Release → review and merge its PR → automatic tag and deployment dispatch → production approval**. The Release workflow chooses the bump from the latest release tag and changes workspace manifests in lockstep. Feature changes do not edit manifest versions. Do not create tags by hand or deploy with a manual production `git pull`.

The tag workflow also publishes eligible packages independently of the production approval and records release close-out. Publication does not prove production deployment. See [npm publishing](../npm-publishing.md).

## Workflow ordering

Both environment workflows follow this order:

1. Fetch the intended source and synchronize the tracked ecosystem configuration to the environment's live config path.
2. Install dependencies without lifecycle scripts, then explicitly rebuild the required native SQLite dependency.
3. Check that the vault path used for provisioning matches the kernel process's path.
4. Build workspace packages needed by provisioning.
5. Apply kernel-owned migrations before provisioning imports the current schema.
6. Provision service bootstrap identities using the kernel environment file and selected ecosystem configuration.
7. Snapshot intentionally stopped processes before a build can restart anything.
8. Build affected ecosystem-owned workspace apps through `build-changed.sh`.
9. Reap orphan listeners, reconcile ecosystem-owned process definitions and restart other selected processes by name.
10. Persist PM2 state, assert listener ownership, install the PM2 health schedule and run post-deploy health checks.

The production kernel is reconciled from the ecosystem file explicitly. Restarting only by name can reuse a stale executable or lose required Node arguments. `pm2-reconcile.sh` replaces stale invocation definitions and restarts matching ones; reconcile failures fail deployment.

Intentionally stopped apps remain stopped under the shared deployment selector, except the explicitly deployed production kernel. Portless cron workers have their own inclusion policy. Extracted apps are not rebuilt or migrated by this repository; a standalone process retaining an environment-prefixed name can still be selected for a name-based restart.

## What deployment evidence means

The build process derives the displayed release identity from Git and stamps a build hash. Compare the routed health response to the intended source; a successful source build is not evidence that the public listener serves it.

Each service reports migration state from its own database connection. The kernel aggregator relays those blocks and degrades when a service reports pending migrations; it does not inspect another app's database directly. Migration head, applied count and pending count are schema evidence, not proof that rollback code remains compatible.

Migration failure, build failure, listener reaping failure and restart failure are deployment failures. The build report distinguishes restart failure from compilation/port-reaping failures. Use the [deployment runbook](../../deploy/README.md) for exit-code interpretation.

PM2 `online` proves a process exists, not that HTTP responds. Kernel process-liveness checks avoid DB, vault and sibling fan-out. Aggregate readiness answers a different question and must not trigger kernel restart merely because a sibling is unhealthy. The [liveness watchdog](../../deploy/README.md#http-liveness-watchdog) documents bounded checks, persistent cooldown/outbox, node-operator attribution and explicit installation. Its source and stub tests do not establish installation on a host.

The repository's declared required-context guard verifies that CI jobs exist. Live branch-protection checks require suitable ruleset-read authority; an advisory check without that authority is not proof of the live setting. Rebase a migration-bearing branch against current main before readiness and resolve numbering collisions without rewriting applied history.

## Configuration and credentials

The tracked [development](../../deploy/ecosystem.dev.config.js) and [production](../../deploy/ecosystem.prod.config.js) ecosystem files own in-repo process definitions. [Environment configuration](../ENVIRONMENTS.md) documents ports, domains and variable ownership. Compare live process definitions safely rather than assuming the tracked file is a deployment inventory.

PM2 process dumps contain full environments and secrets. The workflows use a protected temporary file for the vault consistency check and emit only the selected safe diagnostic. Do not print environment files, full process dumps, cookies or credential values into logs.

Service bootstrap must target the same vault file the kernel reads. App-secret declaration sync does not generate values, activate a grant or restart an app. Operator-supplied credentials require masked entry and a separate countersignature; app runtime adoption needs the documented pre-import vault boot boundary. See the [author](../app-self-secrets-author.md) and [operator](../app-self-secrets-operator.md) guides.

Billing/admin credentials and inference credentials are distinct grants. Loading one does not authorize the other. Loop publication also requires the exact principal's live grant; a reduction in warning volume is not proof of authority.

## Independently owned apps

Coffee, dykil, events, learn, links and market own their source, registration, setup and deployment. Use their owned repository runbooks rather than removed workspace targets. Public routing prefixes and port assignments are in [environment configuration](../ENVIRONMENTS.md).

Do not restore a removed kernel app copy as rollback. Deploy the app's reviewed prior ref with matching build and dependencies, verify its working directory, listener and prefixed health, and persist its process definition. Source extraction is not proof of an app's import or end-to-end acceptance.

App tables and recorded migration history remain intact. The kernel migration runner owns kernel schemas; each standalone app owns its current schema contract and migrations. Do not drop application schemas or normalize historical ledger rows during a deployment.

Payment callbacks to standalone apps have compatibility configuration. Keep a configured legacy bearer and matching receiver secret until that receiver's signed-webhook deployment is independently verified. The kernel's additive signature alone does not establish receiver support. Use each app's runbook for callback adoption; do not infer completion from absence of source in this repository.

## Corpus and inference hosts

Corpus production is assigned to a separate host in the recorded configuration. Configure `CORPUS_SERVICE_URL` for its actual address; localhost is correct only when the daemon is colocated. GitHub partitions require registry-resolved source owners, live owner-issued grants and that owner's selected OAuth connector. Membership or a local CLI login is not consent.

Deploy the owner resolver before the daemon. A separately authorized owner migration requires backups and stopped writers, preserves rows and original signatures, and is not an automatic deploy step. The [corpus runbook](../../apps/corpus/README.md) owns that procedure.

The [inference updater](../../deploy/infer-passthrough/README.md) is separate systemd automation. Before staging a release it checks main ancestry and successful production deployment evidence for the exact SHA. Candidate, live and rollback health use the explicitly declared host auth mode. Source presence is not host installation, and liveness alone does not prove an agent completion.

The [vault SSH action](../deploy/vault-ssh-deploy.md) requires a repository/environment-bound grant, verified GitHub OIDC, host CA/principal configuration, pinned public host keys and non-swappable ephemeral key storage. Credential-free dry runs validate the contract, not a live target or runner's trust configuration.

## Rollback and recovery

Use [the rollback runbook](ROLLBACK.md) to redeploy the reviewed prior ref through the existing approved production workflow. Migration history remains forward-only. Code rollback is safe only if its schema contract is compatible with the already-applied migrations; otherwise use reviewed corrective forward migration or backup recovery.

The [baseline manifest](../../migrations/kernel-baseline.json) fixes the historical cut and checksums. Existing complete databases adopt the baseline without DDL; fresh databases initialize it before pending root migrations. A deployment does not authorize regeneration of that cut, force-adoption, checksum replacement, row deletion or production reinitialization. Follow the [baseline runbook](../../migrations/BASELINE.md).

## Verification boundaries

Serving health/build evidence, a migration report and workflow success answer different questions. None alone proves an application's user flow, a provider account's grants, a runner's host trust or a real-data restore. Record the exact ref and relevant evidence without credential values.

Workflow changes that run privileged follow-ups from reviewed main cannot prove their own post-merge path from a PR. For fork Sonar, verify the trusted exact-head status and actual Sonar issue count separately from a compatibility skip. See [contributor guidance](../../README.md#sonarcloud-on-fork-prs).
