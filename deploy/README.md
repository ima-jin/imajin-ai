# deploy/ — pm2 ecosystem configs (version-controlled)

Source-of-truth copies of the pm2 `ecosystem.config.js` files that run the
Imajin services on **imajin-server** (`192.168.1.193`). Committing them here
stops the silent config drift that comes from editing the live files in place
and never recording the change (#1325).

## Files

| File | Server location | Env |
|------|-----------------|-----|
| `ecosystem.dev.config.js`  | `~/dev/ecosystem.config.js`  | Dev  (kernel port 3000, apps 3xxx) |
| `ecosystem.prod.config.js` | `~/prod/ecosystem.config.js` | Prod (kernel port 7000, apps 7xxx) |

**Provenance:** captured verbatim from the reconciled live server copies as of
**2026-07-16** (the reconciliation date named in #1325). The `cwd` paths are the
server's absolute paths (`/home/jin/dev/...`, `/home/jin/prod/...`) and are kept
as-is because they *are* the deployed values.

## Keeping them in sync

These are the canonical copies. When a pm2 app is added/removed/re-ported:

1. Edit the file here, commit, PR.
2. On the server, copy it into place and reload pm2:
   ```bash
   # dev
   cp ~/dev/imajin-ai/deploy/ecosystem.dev.config.js  ~/dev/ecosystem.config.js
   pm2 reload ~/dev/ecosystem.config.js
   # prod
   cp ~/prod/imajin-ai/deploy/ecosystem.prod.config.js ~/prod/ecosystem.config.js
   pm2 reload ~/prod/ecosystem.config.js
   ```

Do **not** hand-edit the live `~/dev/ecosystem.config.js` / `~/prod/ecosystem.config.js`
without mirroring the change back here — that reintroduces the exact drift this
directory exists to kill.

## `prod-jin` env loading (#1520)

`prod-jin` runs the Next **standalone** server (`node server.js`). Unlike
`next dev` / `next start`, plain `node` does **not** load `.env.local`. Before
this was fixed, the kernel env (including `AUTH_PRIVATE_KEY`) only reached the
process when someone started it by hand with the env exported — so the next
`pm2 restart` silently dropped it. The kernel then fell back to a deterministic
dev signing key and **every sealed vault entry failed `SIGNATURE_INVALID`**
platform-wide, with no error at boot.

Two things now prevent a recurrence:

1. `prod-jin` passes `--env-file` to the Node interpreter via `node_args`,
   pointing at the server's untracked `apps/kernel/.env.local`, so the env is a
   property of the config rather than of whoever ran the last restart.
   **Secrets are never committed here** — only the path is.
2. The kernel refuses to serve in production when `AUTH_PRIVATE_KEY` is absent
   instead of deriving a dev key, and logs its derived vault `senderDid` on
   first vault use.

`--env-file` needs Node ≥ 20.6 — the same mechanism the kernel's own `dev`
script already uses. Do **not** use pm2's `env_file` key: it is not in the pm2
ecosystem reference, so it may be silently ignored, which would drop the key
again without any error.

### Applying it — the prod deploy does this for you

`deploy-prod.yml` now syncs this file and restarts `prod-jin` **from the file**:

- **Sync pm2 ecosystem config** — copies `deploy/ecosystem.prod.config.js` to
  `~/prod/ecosystem.config.js`, before the build so a cold start uses it.
- **Restart prod services** — `pm2 startOrRestart <file> --only prod-jin`, then
  the other `prod-*` processes by name, then `pm2 save`.

`pm2 restart <name>` reuses pm2's *saved* process definition, so a name-based
restart silently ignores changes to this file — including `prod-jin`'s
`--env-file`. That is why the deploy targets the file for `prod-jin`, and why
`pm2 save` runs afterwards: without it a reboot resurrects the stale definition
without `node_args`.

Only needed if applying by hand (out-of-band config change, or verifying):

```bash
cp ~/prod/imajin-ai/deploy/ecosystem.prod.config.js ~/prod/ecosystem.config.js
pm2 startOrRestart ~/prod/ecosystem.config.js --only prod-jin --update-env
pm2 describe prod-jin | grep -i node_args   # confirm it applied
pm2 save
```

Then confirm the identity. It is logged on first vault use, so hit a
vault-backed page (e.g. `/auth/connectors`) first:

```bash
pm2 logs prod-jin --lines 200 | grep 'Vault signing identity derived'
```

Expect the node's real DID and `"devFallback":false`. A `devFallback:true` here
means the key did not load and every sealed entry is unreadable.

The identity is logged on first use rather than at startup on purpose: deriving
it at module-import time would make `next build` (which imports the vault with
`NODE_ENV=production`) fail on any build machine, since those legitimately have
no `AUTH_PRIVATE_KEY`.

### Expected failure modes (both are the guard working)

- Node exits immediately with `node: /path/.env.local: not found` — the env file
  is missing at the configured path. `--env-file` fails hard by design, so pm2
  will crash-loop rather than serve with the wrong identity.
- Requests fail with `AUTH_PRIVATE_KEY is required in production` — the file
  loaded but does not define the key.

In either case the rollback is the pre-#1520 manual start, which gets prod
serving again while the config is fixed:

```bash
cd ~/prod/imajin-ai/apps/kernel && set -a && . .env.local && set +a
pm2 restart prod-jin --update-env
```

## Known drift captured on 2026-07-16 (documented, not yet reconciled)

The prod file does **not** match what actually runs, in two ways. Both are
recorded here deliberately so the file is an honest snapshot, not an idealized one:

1. **Compiled-kernel services.** `prod-auth`, `prod-registry`, `prod-connections`,
   `prod-pay`, `prod-profile`, `prod-chat`, `prod-media` are listed as separate
   pm2 apps (ports 7001–7009) but in practice are **compiled into the single
   `prod-jin` kernel process** on port 7000 and served as path prefixes
   (`/auth`, `/media`, …), not as separate processes/subdomains. They will not
   appear in `pm2 list`. `prod-jin` itself was started ad-hoc as
   `server.js -p 7000`. Dev has no equivalent split — dev runs the one
   `dev-jin` kernel process.

2. **`prod-scorecard` (port 7402)** exists in prod (`~/prod/imajin-scorecard`)
   with no dev counterpart, and is not yet reflected in the deploy skill's
   process table.

Reconciling the prod file to reality (drop the compiled-in services, or annotate
them explicitly) is follow-up work — this commit's job is to *capture* the current
state under version control, not to change what runs.

## `scripts/build.sh` exit codes (#2382)

Both `deploy-dev.yml` and `deploy-prod.yml` invoke `build.sh` indirectly, via
`scripts/build-changed.sh` under `set -euo pipefail`. Neither workflow
branches on the *specific* exit code today — any non-zero exit already fails
the Actions job — but the values below are still fixed and meaningful for
anyone reading a failed run's log, so keep them stable:

| Exit code | Meaning |
|-----------|---------|
| `0` | Every app built, every port was clear, and every service (re)started. |
| `1` | A build `FAILED` and/or an orphaned port could not be cleared (`PORT_REAP_FAILED`). |
| `2` | Every app built and every port was clear, but pm2 could neither restart nor cold-start one or more services (`RESTART_FAILED`). |

Code `2` closes the gap reported in #2382: before this fix, a service that
failed to restart (`build.sh:290-347`) fell into `RESTART_FAILED` but the
final exit check (`build.sh:362`, pre-fix) only looked at `FAILED` and
`PORT_REAP_FAILED` — so a dirty restart left a green Actions run. See
`docs/ops/DEPLOY-POSTURE.md` §2/§4.1 item 4 for the original investigation.

## corpus is not in the prod pm2 config (#2232, decided 2026-09-22)

`ecosystem.prod.config.js` has no `prod-corpus` entry. Per #2232 (multi-host
deploy), corpus runs on **gx10**, not this host (the ProLiant) — Ryan decided
this explicitly, closing the open question from #2246/#2249 about whether
corpus belongs in this repo's prod pm2 config. `dev-corpus` stays in
`ecosystem.dev.config.js`: corpus still runs in dev on this host today.

This file's `cwd` entries are also the source `scripts/check-env.ts` (#2246)
reads to decide, per environment, whether a service with no `.env.local` is a
hard error (it's a deploy target here) or just a warning (it isn't). Removing
`prod-corpus` is what makes a missing `apps/corpus/.env.local` a warning under
`check-env --env prod` instead of the error it was before — do not re-add a
`prod-corpus` block solely to silence that warning; only add it back once
corpus is actually deployed on this host again.
