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

1. `prod-jin` declares `env_file` pointing at the server's untracked
   `apps/kernel/.env.local`, so the env is a property of the config rather than
   of whoever ran the last restart. **Secrets are never committed here** — only
   the path is.
2. The kernel refuses to boot in production when `AUTH_PRIVATE_KEY` is absent
   instead of deriving a dev key, and logs its derived vault `senderDid` at
   startup.

`env_file` requires pm2 ≥ 5.3. Verify after a restart:

```bash
pm2 restart ~/prod/ecosystem.config.js --only prod-jin --update-env
# The vault identity is logged at boot — confirm it is the expected node DID:
pm2 logs prod-jin --lines 200 | grep 'Vault service initialised'
```

If the kernel exits immediately with an `AUTH_PRIVATE_KEY is required in
production` error, the env file is missing or unreadable — that is the guard
working, not a regression.

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
