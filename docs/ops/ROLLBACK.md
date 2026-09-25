# Prod rollback — redeploy the last good tag (#2385)

Ruled on #2060 (option a): **migrations are forward-only. Rollback means redeploying the last good
tag, and dealing with the schema consequences.** There are no down-scripts and none are coming.

Every claim below cites a file:line on `main`. Nothing here needs `ssh`.

## When to roll back

Roll back when prod is serving the wrong behaviour and the fix isn't a five-minute forward patch:

- A deploy shipped a functional regression (bad page, broken auth flow, wrong data rendered).
- `deploy-prod.yml` went green but a service didn't come back. A failed `pm2 restart` is only
  **warned** about — `build.sh` collects it into `RESTART_FAILED` (`scripts/build.sh:346-348`) but
  its exit line folds in only `FAILED` and `PORT_REAP_FAILED` (`scripts/build.sh:362`), so a dead
  service can leave a green run.

Do **not** roll back for:

- **A failed migration.** `scripts/migrate.mjs` applies each file in a transaction and exits
  non-zero on error (`scripts/migrate.mjs:159-165,177-184`), so the job fails before restart. The
  recovery is a corrective **forward** migration, not an older tag — the old tag runs the same
  pending migration again and fails the same way.
- **A `prod-jin` env-file failure** (`AUTH_PRIVATE_KEY is required in production`, or node exiting
  with `.env.local: not found`). That's the #1520 mode with its own documented recovery at
  `deploy/README.md:103-117`; an older tag won't fix a missing file on the box.

## Pick the last good tag

This repo ships tags, not GitHub Releases — `tag-release.yml` creates and pushes an annotated
`vX.Y.Z` (`.github/workflows/tag-release.yml:80-92`) and nothing publishes a Release, so
`gh release list` is empty. Use tags plus the deploy run log:

```bash
# candidate tags, newest first
git fetch --tags --prune --prune-tags origin
git tag --list 'v[0-9]*' --sort=-v:refname | head -10

# which tag actually deployed, and whether that run went green
gh run list --workflow deploy-prod.yml -R ima-jin/imajin-ai \
  --json headBranch,event,conclusion,createdAt,url --limit 20
```

`headBranch` is the tag the run deployed — `tag-release.yml` dispatches with `--ref "$TAG"`
(`.github/workflows/tag-release.yml:124`). The last good tag is the newest tag whose
`deploy-prod.yml` run concluded `success` **and** which you have no regression reports against.
Skip any tag whose run is `failure`/`cancelled`, and remember a green run can still hide a failed
restart (above) — prefer a tag you have observed serving.

## The command

```bash
gh workflow run deploy-prod.yml -R ima-jin/imajin-ai -f ref=<tag>
```

`-f ref=` is `deploy-prod.yml`'s own `workflow_dispatch` input, declared with default `main`
(`.github/workflows/deploy-prod.yml:6-11`) — always pass it explicitly or you redeploy `main`. The
run then waits on the `production` GitHub Environment's required reviewer
(`.github/workflows/deploy-prod.yml:13-16,24`); a rollback is approved like any other prod deploy.
Runs serialize on the `deploy-prod` concurrency group without cancelling in flight
(`.github/workflows/deploy-prod.yml:17-19`), so a rollback queues behind the bad deploy rather than
racing it.

What the run does with that ref: `git fetch --prune --prune-tags` then `git reset --hard <ref>`
(`.github/workflows/deploy-prod.yml:35-41`), sync the pm2 ecosystem file
(`:43-49`), install (`:51-60`), `./scripts/build-changed.sh` (`:62-66`), `node scripts/migrate.mjs`
(`:68-69`), reap orphan ports (`:71-72`), restart (`:74-102`).

`build-changed.sh` diffs the last-built SHA against the checked-out SHA
(`scripts/build-changed.sh:73-79`) — `git diff` is direction-agnostic, so going backwards rebuilds
exactly the apps that differ, and `.last-build-sha` is only stamped after a successful build
(`scripts/build-changed.sh:114-115`). No special handling is needed to deploy an older ref.

## What does NOT roll back: the schema

Migrations are forward-only and idempotent by rule (`docs/MIGRATIONS.md:51-56`) and by
implementation: `runMigrations()` only applies files absent from `public._migrations` and never
reverses one (`scripts/migrate.mjs:128-168`). Redeploying an older tag therefore leaves the database
at the **newer** schema. The old code runs against new columns and tables.

That is safe only because migrations are additive — see Consequences.

## Verify

1. **Version/build.** `curl -s https://<prod-host>/api/health | jq '{version, build}'` — kernel's
   route returns `NEXT_PUBLIC_VERSION` and `NEXT_PUBLIC_BUILD_HASH`
   (`apps/kernel/app/api/health/route.ts:90-96`), stamped at build time from `git describe` /
   `git rev-parse --short HEAD` on the checked-out ref (`scripts/build.sh:104-124`). After a
   rollback, `version` must equal the tag you deployed and `build` its short SHA. Same route also
   reports every downstream service's up/down state (`:84-96`) — use it to confirm the restart took.
2. **Migration head.** Not queryable today: no health route reads `public._migrations`
   (`docs/ops/DEPLOY-POSTURE.md:56-58`). Once **#2384** lands (per-app `/api/health` reports its own
   schema head, kernel's aggregator relays it — `docs/ops/DEPLOY-POSTURE.md:162-165`), also confirm
   the head is **at or ahead of** the rolled-back code's expectations. Until then the migration state
   is only visible in the deploy run log.
3. **The run log itself** is the record of what was deployed and who approved it
   (`.github/workflows/deploy-prod.yml:13-16`).

## Consequences of forward-only

Rollback works *only* if every release's code tolerates the next release's schema. That is a
standing constraint on how migrations are written, not a rollback-time step.

- **Additive-only.** A migration may add tables, columns, indexes and defaults. New columns must be
  nullable or defaulted so the previous release's `INSERT` (which doesn't mention them) still
  succeeds.
- **Never drop or rename in the release that stops using a column.** That release is the one most
  likely to be rolled back, and its predecessor still reads the column. Stop writing it in release
  N; drop it in N+1 or later.
- **Rename = add + backfill + dual-write, then drop later.** An in-place rename breaks the previous
  release instantly.
- **A rollback across a destructive migration is not a rollback** — it's an outage. If one has
  already shipped, the only path is forward: fix, tag, deploy.

The one-line rule, also recorded in `docs/MIGRATIONS.md`:

> A column or table may be dropped only **≥1 release after** the last code that reads it shipped.

## See also

- `docs/ops/DEPLOY-POSTURE.md` — how code reaches dev and prod, what's machine-checkable, known drift.
- `docs/MIGRATIONS.md` — migration rules, ownership, tracking table.
- `deploy/README.md:103-117` — the #1520 `prod-jin` env-file failure and its manual recovery.
