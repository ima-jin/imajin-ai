# Release deployment for infer-passthrough (#3041, #3082)

This is a **one-time operator install**, not a change to any live host by this PR.
Thereafter the timer fetches release tags and `origin/main` every two minutes.
It selects the highest eligible stable `vX.Y.Z` (not a prerelease), without a
recurring hand step. **The updater follows the production gate**: a tag alone is
not permission to run code with production app credentials. No tags or deployments
are created here, and Ryan's existing `production` approval gate is not bypassed.

## Deployment contract

Before staging, installing, building or starting any tagged code, it requires:

1. The tag's exact commit is on freshly fetched `origin/main`, verified with
   `git merge-base --is-ancestor`.
2. GitHub's Deployments API returns a deployment for **that exact SHA** and
   `environment=production` whose **latest status is `success`**. Pending approval,
   an in-progress/failed/inactive deployment, and another SHA/environment do not
   qualify. An older success on the same deployment cannot override a newer status.

An ineligible tag is logged and skipped; the newest eligible release is selected.
A stray high off-main tag therefore cannot pin out future legitimate releases.
If none qualifies, the updater logs refusal and leaves `current` and the live
unit untouched. Credential/API errors abort the update, never authorize a fallback.
The API check is read-only, paginated and bounded; it refuses malformed evidence
and redirects. The credential is separate from the app's minting key.

The updater stages a detached checkout for the approved release SHA, installs the frozen
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

Keep the existing unit as-is until this change lands and its release completes
the normal `production` deployment. Then install **from that approved release's
tracked `deploy/infer-passthrough/` files**, not an arbitrary main working tree.
These are the one-time operator steps, not host actions performed by this PR.
Run with root privileges from the approved release artifact:

```bash
install -d -m 0755 /usr/local/libexec/infer-passthrough
install -m 0755 deploy/infer-passthrough/update.sh /usr/local/libexec/infer-passthrough/
install -m 0644 deploy/infer-passthrough/check-health.mjs /usr/local/libexec/infer-passthrough/
install -m 0644 deploy/infer-passthrough/production-deployment.mjs /usr/local/libexec/infer-passthrough/
install -d -m 0755 /var/lib/imajin/infer-passthrough
install -d -o imajin -g imajin -m 0755 /var/lib/imajin/infer-passthrough/releases
install -d -o imajin -g imajin -m 0755 /var/lib/imajin/infer-passthrough/repo
runuser -u imajin -- git clone --bare https://github.com/ima-jin/imajin-ai.git /var/lib/imajin/infer-passthrough/repo
```

The root-owned state directory must stay non-writable by the service account.
The bare repository is only a fetch/object store, never a working tree to pull or
run. Place this **non-secret** config in
`/etc/imajin/infer-passthrough-update.env`:

```ini
INFER_UPDATE_REPO=/var/lib/imajin/infer-passthrough/repo
INFER_UPDATE_USER=imajin
INFER_UPDATE_PORT=8787
INFER_UPDATE_CANDIDATE_PORT=8788
```

Provision a **read-only**, repository-scoped GitHub credential through the normal
secret-management channel into `/etc/imajin/infer-passthrough-github-token`
(root-owned, mode 0600). Use a fine-grained token or GitHub App installation token
with **Deployments: read**, **Contents: read** (for separate git access if needed)
and metadata read only; **no write, Actions-write or administration permissions**.
Rotate it through that same channel. Never put its value in env files, commands,
logs, a unit, or this repository. The tracked updater unit uses
`LoadCredential=github-token:...`; the helper reads it from systemd's restricted
credential directory. It makes only GET requests to the fixed GitHub API origin.
No credential value is passed in argv/env or to a release's candidate process.
An absent/expired/unauthorized credential fails closed before tagged code runs.

As part of this one-time install only, initialize `current` as a symlink to the
existing **installed** service checkout, readable by the service account, as the
initial rollback target. Do not pull, install, build or modify that checkout.
The updater replaces this initial link with an approved detached release
directory only after its mint health succeeds. It retains prior release
directories for rollback. Thereafter all release code comes from the tag's pinned
SHA, not a mutable working checkout. Never deploy by `git pull`.

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

The first updater run must select a production-approved release containing this fix; older releases
do not have mint-backed `/health` and fail safely before promotion. Do not enable
the timer until that release has successfully deployed through the normal
production workflow after Ryan's gate tap.

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
The release checker only contacts the fixed loopback `/health` endpoint and
refuses redirects; its port argument cannot supply a host or path.
Mint success does not claim a billed model completion happened or that no grant
was revoked after the last mint; cached tokens retain the kernel's normal TTL.

`update.sh --dry-run` fetches main/tags, checks ancestry and production approval,
and reports the newest eligible stable release and
health/rollback steps, without installing, switching code or calling systemd.
Run it with the updater's non-secret config loaded and a systemd credential
context (a transient service may use the same `LoadCredential` setting).
`update.sh --check` only checks live `/health` and needs no GitHub credential.
The updater fails closed on missing eligible release tags, off-main commits,
missing successful production deployments, unreadable credentials/API errors, dirty/mismatched staged
checkouts, failed install/build, failed candidate health, or failed live health.
Polling retries a failed release on the next timer tick. Inspect the health body
for the route to re-consent; no grant ID needs copying.

Tests use temporary git repositories and stubbed systemd/install commands,
without sudo, host access or real credentials:

```bash
pnpm --silent test:agent packages/openclaw-infer-passthrough/tests scripts/__tests__/infer-passthrough
```
