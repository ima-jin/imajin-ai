# Release deployment for infer-passthrough (#3041)

This is a **one-time operator install**, not a change to any live host by this PR.
Thereafter the timer fetches release tags every two minutes, selects the highest
stable `vX.Y.Z` (not a prerelease), and deploys without a recurring hand step.
No release tags are created here. This is independent of the production kernel's
existing deploy approval gate; it only updates this local proxy.

## Deployment contract

The updater stages a detached checkout for the release SHA, installs the frozen
lockfile without lifecycle scripts, and builds `@imajin/auth` and its workspace
dependencies. Install/build and the proxy run as `imajin`, **not root**. Root only
orchestrates worktrees, the atomic `current` symlink and systemd.

Before touching the live service, a transient `infer-passthrough-candidate` unit
runs the new code on **127.0.0.1:8788**, using the same restricted EnvironmentFile.
The candidate's `/health` must mint (or cache a valid token) for **every configured
route**, including MCP. Break-glass cannot satisfy this probe. The candidate is
stopped, `current` atomically switches to the release checkout, and the live unit
restarts. A second `/health` check gates success. Any post-promotion failure,
including a failed restart or TERM/INT, switches `current` back, reinstalls no
dependencies, restarts the previous code and checks rollback health. A failed
preflight never restarts live. All old release directories are retained.
Failures exit nonzero and log the failed phase and rollback outcome in journald.
A failed mint names its route and the **/jin → Grants** remedy in `/health`.

## One-time installation / migration

Use a maintenance window. Prerequisites: Linux with systemd (`systemd-run`,
`runuser`, `flock`), Node 22 and pnpm 9 on `/usr/local/bin:/usr/bin:/bin`, git,
and an existing `imajin` service account with read-only repository access.
If the host currently uses another service user, use that account consistently
in the live unit and `INFER_UPDATE_USER` below. Never give repository code root.

Run the following as the operator with root privileges, **from this repository**:

```bash
install -d -m 0755 /usr/local/libexec/infer-passthrough
install -m 0755 deploy/infer-passthrough/update.sh /usr/local/libexec/infer-passthrough/
install -m 0644 deploy/infer-passthrough/check-health.mjs /usr/local/libexec/infer-passthrough/
install -d -m 0755 /var/lib/imajin/infer-passthrough
install -d -o imajin -g imajin -m 0755 /var/lib/imajin/infer-passthrough/releases
runuser -u imajin -- git clone https://github.com/ima-jin/imajin-ai.git /var/lib/imajin/infer-passthrough/releases/bootstrap
```

The root-owned state directory must stay non-writable by the service account.
Use the bootstrap checkout as the repository for worktree operations by placing
this **non-secret** config in `/etc/imajin/infer-passthrough-update.env`:

```ini
INFER_UPDATE_REPO=/var/lib/imajin/infer-passthrough/releases/bootstrap
INFER_UPDATE_USER=imajin
INFER_UPDATE_PORT=8787
INFER_UPDATE_CANDIDATE_PORT=8788
```

Prepare the bootstrap code as `imajin` (the updater cannot roll back to an
uninstalled checkout):

```bash
runuser -u imajin -- pnpm --dir /var/lib/imajin/infer-passthrough/releases/bootstrap install --frozen-lockfile --ignore-scripts --loglevel=error
runuser -u imajin -- pnpm --dir /var/lib/imajin/infer-passthrough/releases/bootstrap exec turbo run build --filter=@imajin/auth --output-logs=errors-only
ln -s /var/lib/imajin/infer-passthrough/releases/bootstrap /var/lib/imajin/infer-passthrough/current
```

Alternatively, point `current` at the existing **installed** proxy checkout for
the first rollback target, retaining that directory unchanged. The dedicated
bootstrap repo above is still used to fetch/stage releases. Never deploy by
`git pull` or update a shared working checkout in place.

1. Retain the app identity/key and kernel URL in
   `/etc/imajin/infer-passthrough.env`; use `infer-passthrough.env.example` for
   **names only**. Set `INFER_PROXY_PRINCIPAL_DID` to the owner of the live grant.
   Secrets belong only in this root-owned, mode-0600 file; systemd reads it for
   both unprivileged processes. Never put secrets in the updater env, commands,
   units, logs or PRs. Do not overwrite the existing file with the blank example.
2. Remove **every** `INFER_PROXY_ROUTES_CONFIG` assignment from the effective
   unit, its drop-ins and environment file unless deliberately using optional
   principal-based break-glass overrides. The old routes file need not be edited
   or deleted. No grant/attestation ID is in the shipped template or required at
   runtime. Leftover `INFER_PROXY_*GRANT_ID` / `*_ATTESTATION_ID` and `OPENCLAW_`
   equivalents are ignored with one warning, also shared with legacy JSON fields.
3. Confirm consent on **/jin → Grants**. Future re-consent needs no edits or
   restart; minting resolves the live grant by principal + app identity.
4. Retain a copy of the prior unit for operator rollback. Install the live unit,
   updater and timer below. Check existing drop-ins do not override `ExecStart`
   or `WorkingDirectory`. If changing ports, change the service EnvironmentFile
   and updater config together; live and candidate ports must differ.

```bash
install -m 0644 deploy/infer-passthrough/infer-passthrough.service /etc/systemd/system/
install -m 0644 deploy/infer-passthrough/infer-passthrough-update.service /etc/systemd/system/
install -m 0644 deploy/infer-passthrough/infer-passthrough-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now infer-passthrough.service
systemctl restart infer-passthrough.service
systemctl start infer-passthrough-update.service
systemctl enable --now infer-passthrough-update.timer
```

The first updater run must select a release containing this fix; older releases
do not have mint-backed `/health` and fail safely before promotion. Do not enable
the timer until that release is tagged through the normal release workflow.

## Release check and diagnosis

The release check and updater use **the same mint-backed `/health` route**:

```bash
node /usr/local/libexec/infer-passthrough/check-health.mjs 8787
curl --fail-with-body --silent http://127.0.0.1:8787/health
systemctl status infer-passthrough-update.timer infer-passthrough-update.service
journalctl -u infer-passthrough-update.service -n 60 --no-pager
```

HTTP 200 means each route has minted or holds an unexpired token; 503 includes
failed route IDs and **/jin → Grants** guidance, never token/key material. Existing
fallback and passthrough-error counters remain on both `/health` and `/healthz`.
Mint success does not claim a billed model completion happened or that no grant
was revoked after the last mint; cached tokens retain the kernel's normal TTL.

`update.sh --dry-run` fetches tags and reports the newest stable release and
health/rollback steps, without installing, switching code or calling systemd.
Run it with the updater's non-secret config loaded, or via its environment
overrides. `update.sh --check` only checks live `/health`.
The updater fails closed on missing release tags, dirty/mismatched staged
checkouts, failed install/build, failed candidate health, or failed live health.
Polling retries a failed release on the next timer tick. Inspect the health body
for the route to re-consent; no grant ID needs copying.

Tests use temporary git repositories and stubbed systemd/install commands,
without sudo, host access or real credentials:

```bash
pnpm --silent test:agent packages/openclaw-infer-passthrough/tests scripts/__tests__/infer-passthrough
```
