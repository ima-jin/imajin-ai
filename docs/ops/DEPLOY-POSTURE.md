# Deploy posture — current state and target (#2060)

Repo-only investigation. No server access was used or attempted — every claim below is either a
citation to a file in this repo or explicitly marked as unverifiable from the repo alone.

## 1. How code reaches dev and prod today

Both pipelines share one shape — `pull latest → sync pm2 config → install → build changed → migrate →
reap orphan ports → restart` — but differ in trigger and gate.

**Dev** (`.github/workflows/deploy-dev.yml`): triggered by `workflow_run` on CI completing
successfully on `main` (`deploy-dev.yml:4-7`). No human step. Runs on `[self-hosted, imajin]`
(`deploy-dev.yml:21`), `git reset --hard origin/main` (`deploy-dev.yml:37`), syncs
`deploy/ecosystem.dev.config.js` → `~/dev/ecosystem.config.js` (`deploy-dev.yml:44`), installs deps
with `--ignore-scripts` + a targeted `better-sqlite3` rebuild (`deploy-dev.yml:48-56`), runs
`./scripts/build-changed.sh` (`deploy-dev.yml:59`), runs `node scripts/migrate.mjs` unconditionally
against whatever `DATABASE_URL` the box resolves (`deploy-dev.yml:62`), reaps orphan ports
(`deploy-dev.yml:65`), then `pm2 restart` on every `dev-*` process (`deploy-dev.yml:67-76`). **Dev
already auto-deploys on every merge to `main`** — one of the issue's proposed postures already
exists, just undocumented outside this workflow file.

**Prod** (`.github/workflows/deploy-prod.yml`): triggered by a `v*` tag push or manual
`workflow_dispatch` (`deploy-prod.yml:3-11`), gated by the GitHub Environment `production`'s required
reviewer (`deploy-prod.yml:13-15,24`) — a human approves the run before any step executes, but the
step sequence itself is identical in shape to dev: pull, sync `ecosystem.prod.config.js`, install,
`build-changed.sh`, `migrate.mjs`, `reap-orphans.sh prod`, then a **`prod-jin`-specific**
`pm2 startOrRestart <file> --only prod-jin --update-env` before the rest are restarted by name
(`deploy-prod.yml:74-102`, rationale for the `prod-jin` special case in the inline comment and
`deploy/README.md:39-77` — a name-based `pm2 restart` silently drops `--env-file`, which caused
`AUTH_PRIVATE_KEY` to fall out from under prod once already, #1520).

**Tags are cut, not typed.** `AGENTS.md`'s "Deploy guardrails" section and `release.yml` describe the
only sanctioned path: `gh workflow run release.yml -f bump=patch|minor` bumps every workspace
`package.json` in lockstep (`scripts/bump-workspace-version.mjs`) and opens a `release: vX.Y.Z` PR
(`release.yml:72-155`); merging it (`tag-release.yml`, triggered on push to `main`) tags the merge
commit and dispatches `deploy-prod.yml` against that tag (`tag-release.yml:80-124`) — which still
waits on the same `production` environment reviewer. Nothing in the chain bypasses branch protection
or that gate.

**Human steps, named:** (1) deciding to dispatch `release.yml` and picking `patch` vs `minor`; (2)
reviewing/merging the release PR; (3) approving the `production` environment's pending deployment in
`deploy-prod.yml`. Everything else — build, migrate, restart, both envs' pm2 sync — is scripted.
Env vars are added by hand-editing `.env.local` on the box (`docs/ENVIRONMENTS.md:104-244`); there is
no deploy-time step that provisions a new var, only `scripts/check-env.ts` refusing to build if one
required by `.env.example` is missing (`docs/ENVIRONMENTS.md:126-137`, invoked from
`scripts/build.sh:62-84`).

## 2. What's machine-checkable now vs asserted

**Build stamp in the running system — partially checked.** Every app's `GET /api/health` returns
`version` (from `NEXT_PUBLIC_VERSION`, tag-derived) and `build` (`NEXT_PUBLIC_BUILD_HASH`, short git
SHA) — e.g. `apps/coffee/app/api/health/route.ts:4-10`, `apps/kernel/app/api/health/route.ts:90-96`,
`apps/market/app/api/health/route.ts:4-10`. Both are stamped at build time by
`scripts/build.sh:104-124` from `git describe`/`git rev-parse` on the checked-out ref. A human asking
"what SHA is this service running" gets a real answer from a `GET`, not an `ssh` — issue item 1 is
already true for build identity. **Not checked:** migration head. No `/health` route queries
`public._migrations`; there is no way to ask a running service "are you caught up" without
`ssh + psql`.

**Migrations applied — asserted only.** `scripts/migrate.mjs` runs unconditionally in both deploy
workflows (`deploy-dev.yml:62`, `deploy-prod.yml:69`) and fails the job (non-zero exit,
`scripts/migrate.mjs:177-184`) if a migration errors — so "did migrate.mjs report success on the last
deploy run" is machine-checkable **from the Actions run log**, but "is the live DB caught up right
now" is not exposed anywhere a caller can query.

**Services restarted — asserted, and now enforced (#2382, fixed).** `build.sh` restarts each
succeeded app individually and collects `RESTART_FAILED` (`scripts/build.sh:294-354`), logged to
`.build-report` and the job log. A failed restart now fails the deploy job too: `build.sh`'s exit
code folds in `RESTART_FAILED` as a distinct, documented exit code `2` (see
`deploy/README.md`'s "`scripts/build.sh` exit codes" section), separate from exit `1` for
`FAILED`/`PORT_REAP_FAILED`. Before this fix, a service that failed to restart could leave a green
Actions run — see `scripts/build-restart-failed.test.sh` for regression coverage.

**Rollback — now defined, still not machine-checked.** `docs/ops/ROLLBACK.md` (#2385) is the runbook:
redeploy the last good tag with `gh workflow run deploy-prod.yml -f ref=<tag>`, migrations stay
forward-only. Nothing verifies a rollback automatically — no check compares the tag prod is serving
to the tag that was intended. The other committed "rollback" text, `deploy/README.md:111-117`, is an
emergency manual restart for the #1520 env-file failure mode specifically, not a bad-deploy rollback.

**Drift, main vs deployed — not machine-checked at all today.** Nothing polls dev/prod `/health` and
compares to `origin/main`'s SHA. The issue's own root-cause story (prod running a commit from a day
before `main`) would still go undetected today; only the build-stamp half of the fix (above) exists.

## 3. Drift risks visible in the repo

**Version source-of-truth conflict — fixed by #2352 (merged 2026-09-25).** Until this merged,
`scripts/bump-workspace-version.mjs` read the **root `package.json`'s own version** as the bump base,
not the latest tag. That left `package.json` at `0.8.2` while three hot-fix tags (`v0.8.3`–`v0.8.5`)
had already been pushed by hand — the next `release.yml bump=patch` dispatch would have recomputed
`0.8.3` and collided with the already-tagged `v0.8.3` (the exact failure #2349 reported, run
36031435178). #2352 fixed it two ways: `resolveBaseVersion()` in `scripts/bump-workspace-version.mjs`
(lines 109-125) now derives the bump base from `latestTagVersion()` — the latest reachable `vX.Y.Z`
tag, via the new shared helper `scripts/lib/git-version.mjs:53-66` — falling back to `package.json`
only when no tag exists yet; and the new `scripts/ci-guard-version-tag-sync.mjs` (wired into `ci.yml`'s
"CI Guards" job) now fails CI whenever `package.json`'s version is behind the latest tag, so this
specific drift can't reaccumulate silently. Root `package.json` is `0.8.5` as of this branch's rebase
(`package.json:3`), matching the latest tag `v0.8.5` — confirmed via
`git tag --list 'v*' --sort=-v:refname`. This is a different mechanism from the earlier-merged
`scripts/lib/build-version.sh` (#2285/#2287), which only ever fixed what the *build footer* displays
(`scripts/build.sh:104-124`) — that fix never touched what `release.yml` computes as the *next*
version, which is the bug #2349/#2352 actually addressed.

**Migration numbering collisions — a recurring pattern, not a one-off.** `scripts/check-migrations.sh`
hard-fails on a duplicate number (`check-migrations.sh:59-68`) and runs both in `ci.yml`'s
"Check Migrations" job (required, per `.github/required-checks.json:18-24`) and in
`check-migrations.yml` on every push to `main`. Despite that, this repo's history shows **at least
eight** post-hoc renumbering fixes for exactly this collision: `4c894012` (0133/0134), `87021dc6`
(0137), `bbac5218` (0141), `c942f21f` (0145), `32a12aa7`/`2ac072a7`/`29b91690` (0152→0153→0156), and
**twice in the same week** around 2026-09-23 at `0158` — `4301183c` renumbered a
`registry.apps.redirect_uris` migration `0158→0159` to avoid colliding with #2331's
`0158_notify_templates.sql`, and separately `f601b34d` renamed `0161_push_subscriptions` to `0162`
after `0158_push_subscriptions.sql` (added by the phone-push PR, commit `a3515c61`) collided with the
already-landed `0158_notify_templates.sql`. The guard is real and does fail the build — but only
**after** the collision has already landed on `main` (or when a PR's own CI happens to run against a
freshly-updated base). Two PRs branched from the same `main` tip each pick the next free number
independently, both pass CI against their own stale base, and the second one to merge is what actually
introduces the collision — caught by `check-migrations.yml`'s `push: branches: [main]` trigger, but
only after the fact, requiring a follow-up fix commit each time. (Repo access alone can't confirm
whether GitHub's branch-protection ruleset requires branches to be "up to date" before merge for this
repo — `gh api repos/.../branches/main/protection` returns `403` for this token, per the same
limitation `scripts/ci-guard-required-contexts.mjs`'s header comment describes. Given eight+ real
collisions, whatever the setting is, it isn't preventing this class of race today.)

**Documented, self-acknowledged drift in the prod pm2 config.** `deploy/README.md:119-139` states
outright that `ecosystem.prod.config.js` does not match what actually runs prod: `prod-auth`,
`prod-registry`, `prod-connections`, `prod-pay`, `prod-profile`, `prod-chat`, `prod-media` are listed
as separate pm2 processes but are actually compiled into the single `prod-jin` process, and
`prod-scorecard` runs in prod with no corresponding entry reconciled elsewhere. This is exactly the
"asserted, not observed" failure mode the issue is about, admitted in-repo rather than hidden.

**A dead cross-reference.** `docs/ENVIRONMENTS.md:248` still points to `../DEPLOYMENT.md` ("See
DEPLOYMENT.md for the full deployment pipeline") — that file was deliberately deleted
(`3a79c11a chore: remove stale DEPLOYMENT.md and PATTERNS.md — covered by DEVELOPER.md and
ENVIRONMENTS.md`). Low-stakes, but it's a doc telling a reader (or an agent) to go read a file that no
longer exists.

**Env vars referenced by deploy workflows but not documented — checked, not found live today.** The
issue's original example (`PROFILE_INTERNAL_API_KEY`, `REGISTRY_SERVICE_URL` needing `/registry`) is
now documented in every consuming app's `.env.example` (`apps/kernel/.env.example:140`,
`apps/events/.env.example:81-82`, `apps/learn/.env.example:48-49`; `REGISTRY_SERVICE_URL` present with
the `/registry` suffix in `apps/coffee/.env.example:20`, `apps/events/.env.example:28`,
`apps/kernel/.env.example:211`, `apps/learn/.env.example:21`, `apps/market/.env.example:21`) — this
specific instance from the "why now" section has since been fixed. It's evidence the underlying
gap (a var lands in a PR body / chat and only gets into `.env.example` as a follow-up) is real, not
that it's currently unresolved.

**No down-migration for schema changes — by ruling, not by omission.** `scripts/migrate.mjs` only
ever applies forward (`migrate.mjs:128-175`); there is no down-migration mechanism and none is
planned (ruled a on the card below). A bad migration's only recovery is a hand-written corrective
forward migration. Rolling the *code* back is now written down (`docs/ops/ROLLBACK.md`), but it
leaves the schema ahead of the code, which is only safe while migrations stay additive — hence the
drop-lag rule in `docs/MIGRATIONS.md`.

## 4. Target posture — a checklist an agent can execute unaided

This is the direct input to epic #2370 gate 5 ("Deploy target"), which explicitly depends on this
issue defining what "deployed to dev" means machine-checkably. Each item below states what it needs on
the server side even though that can't be verified from the repo.

**4.1 — What "deployed to dev" must mean, machine-checkably**
1. `GET /api/health` on the app's routed URL returns a `build` field equal to the SHA the deploy
   workflow just checked out — this mechanism already exists (`scripts/build.sh:104-124`, §2 above)
   and just needs to be the asserted contract, not an implementation detail.
2. `GET /api/health` additionally reports migration state: e.g. `migrationsHead` (the last-applied
   filename or count from `public._migrations`) and `migrationsOwner` (which `--owner` scope, per
   #1991) so a caller can tell "this app's schema is caught up" without `psql`. Today no health route
   queries `_migrations` at all (§2) — this is new work, not a wiring gap.
3. The evidence line epic #2370 already specifies — `ev: repo=… registered=y schema=… deploy=<run>
   health=<version>` — should read `health=<version>+<build>` sourced from #1 directly, not
   transcribed by hand from a log.
4. A restart failure must fail the deploy job. **Fixed (#2382):** `build.sh`'s exit code now folds
   in `RESTART_FAILED` as its own exit code `2` (§2, `deploy/README.md`) — "workflow run succeeded"
   can now be trusted not to hide a dirty restart. Requires: none — this was a same-repo script fix,
   not a server dependency.

**4.2 — Template-level `deploy-dev.yml` shape (for `imajin-app-template`, feeding #2370's per-app
loop)**
`imajin-app-template/.github/workflows/` today has only `ci.yml` and `sonarcloud.yml` — no deploy
workflow exists yet, confirming gate 5 is genuinely open, not just undocumented. Proposed shape,
mirroring this repo's `deploy-dev.yml` but scoped to one app:
- Trigger: `workflow_run` on the template's own CI, `branches: [main]` — same pattern as
  `deploy-dev.yml:4-7`.
- Steps: pull latest, run **that app's own** `migrate.mjs --owner <app>` (per #1991's per-owner mode,
  `migrations/OWNERSHIP.md:273-309`) rather than the unified root runner — an app deployed from the
  template should never be able to touch another app's schema, even accidentally.
- Requires on the server (unverifiable from repo alone): a Caddy path route for `<dev-domain>/<app>`
  through the kernel front door (per #2370's "Deploy target" gate wording), a pm2 process slot in
  `deploy/ecosystem.dev.config.js`-equivalent for the new app (this repo's ecosystem file is a
  version-controlled source of truth per `deploy/README.md:1-37`; the template needs the same pattern
  rather than a hand-edited live file), and a DB role scoped to the app's own schema (created at
  provisioning time per #1991/#2370's "Schema" gate — kernel never learns the app's tables).
- Health gate: the workflow's last step should curl the new URL's `/api/health` and fail the run if
  `build` doesn't match the SHA just deployed — turning "deployed" into a verified assertion inside
  the same workflow run, not a separate manual smoke test.

**4.3 — What stays human**
- Prod tag gate: unchanged. `release.yml` → reviewed PR → `tag-release.yml` → `deploy-prod.yml`'s
  `production` environment required reviewer (`deploy-prod.yml:13-15,24`). Nothing above proposes
  touching this; #2370 itself scopes prod deploy out ("Prod deploy (stays tag + human gate)").
- Choosing `minor` vs `patch` on release dispatch (`release.yml:14-24`) — a judgment call, not a fact
  to assert.
- Approving a *repo-provisioning* action for a brand-new app (new GitHub repo, new DB role/schema) —
  #2370's own gates 1–2 already flag this as needing either elevated bot permissions or a kernel-side
  `apps.provision` route; out of scope here beyond noting the dependency.

**4.4 — Fold in already-in-flight fixes**
- Tag-is-truth for the release bump was merged in #2352 — the `0.8.2`-vs-`v0.8.5` drift described in
  §3 is resolved on `main`. No follow-up needed here; noted so this checklist doesn't re-propose it.
- Consider promoting the migration-numbering collision from "caught after merge" to "caught before
  merge": e.g. a periodic/scheduled re-run of `check-migrations.sh` against `main`'s current tip that
  pages instead of waiting for the next PR's `push` trigger to notice, or a bot that renumbers/rebases
  a PR's new migration file against `main`'s current max at merge time. Both are process changes, not
  server changes, and don't require an ops ruling — flagged here as follow-up, not a DECISION card.

## Decisions for Ryan

DECISION · Migration collision prevention · Should merging a PR that adds a new migration file
auto-rebase its number against `main`'s current max, or should branch protection require an
up-to-date branch before merge? · a) bot auto-renumbers on merge b) require strict up-to-date-before-
merge (may already be set — repo token can't read branch protection to confirm) c) leave the
post-hoc `check-migrations.yml` catch as-is · rec: b — cheapest change, and the eight-plus historical
collisions read as "it isn't set or isn't effective," worth confirming directly rather than adding a
new bot.

DECISION · Migration-head visibility in `/health` · Should the per-owner migration-head field (§4.1
item 2) live on every app's own `/api/health`, or only on kernel's aggregating `/api/health` (which
already polls every other service, `apps/kernel/app/api/health/route.ts:20-38,84-96`)? · a) every
app's own route reports its own migration head b) kernel's aggregator also queries each app's DB
directly for migration head c) kernel's aggregator calls each app's own `/health` (option a) and
relays it · rec: c — keeps each app the source of truth for its own schema state (matches #1991's
per-owner boundary) while still giving one aggregate view.

DECISION · Prod rollback runbook · Should a documented rollback be "redeploy the previous tag via
`gh workflow run deploy-prod.yml -f ref=<previous-tag>`" (already technically possible per
`deploy-prod.yml:6-11`, just unwritten), or something with an explicit down-migration story? ·
a) document the redeploy-previous-tag path only, migrations stay forward-only b) require every new
migration to ship a paired down-script c) defer — no rollback runbook until a real incident forces
the question · rec: a — matches how this repo already treats migrations (idempotent, forward-only,
per `docs/MIGRATIONS.md:51-56`) and costs only documentation, not new tooling.
**Ruled 2026-09-25: a.** Written up in `docs/ops/ROLLBACK.md` (#2385).
