# Release deployment for infer-passthrough (#3041, #3082)

Gateway bootstrap migration is tracked in #3185; no live host is changed by this PR.
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
route**, except the explicitly reported unregistered MCP audience. Break-glass cannot satisfy this probe. The candidate is
stopped, `current` atomically switches to the release checkout, and the live unit
restarts. A second `/health` check gates success. Any post-promotion failure,
including a failed restart or TERM/INT, switches `current` back, reinstalls no
dependencies, restarts the previous code and checks rollback health. A failed
preflight never restarts live. All old release directories are retained.
Failures exit nonzero and log the failed phase and rollback outcome in journald.
A failed mint names its route and a cause-specific remedy in `/health`. Only a
missing live grant recommends **/jin → Grants**. MCP alone may be reported as
`ok: true, skipped: true` on 403 `app_not_registered`; it is not a minted token
and the health hint explicitly requires audience registration. All other MCP
failures and all openai/anthropic failures still gate promotion.

## One-time installation / migration

Keep the existing unit as-is until this change lands and its release completes
the existing `production` approval gate. No gateway changes are performed by this
PR. Subsequent migration is pushed via the **Bootstrap inference gateway**
workflow (`infer-passthrough-bootstrap.yml`), not an interactive sudo session.
The workflow has `permissions: {}` and only starts a fixed root-owned systemd
entry point on the dedicated `infer-passthrough-gateway` host runner. Configure
that runner to accept only protected production workflows, never PR jobs.
Do not dispatch it from a feature branch or install a mutable checkout as root.

### One root grant, once

Ryan's one-time root grant includes installing the reviewed bootstrap bundle and
its service from the **production-approved release artifact**, plus one sudoers
drop-in. All parents and files must be root-owned and not group/world-writable.
The bootstrap refuses symlinked/writable trusted paths. Do not grant sudo to a
script in a home checkout or grant arbitrary `systemctl`, shell, or install access.
The bundle is deliberately not self-updating from a service-writable repository.

The following is the **one-time trusted installation**, not the recurring deploy
command. `release.sha` records the reviewed artifact's exact commit. Verify its
successful production deployment before installing; the bootstrap checks that
same SHA again before migration. Do not use these commands on unreviewed code.

```bash
install -d -o root -g root -m 0755 /usr/local/libexec/infer-passthrough
install -o root -g root -m 0755 deploy/infer-passthrough/bootstrap.sh deploy/infer-passthrough/update.sh /usr/local/libexec/infer-passthrough/
install -o root -g root -m 0644 deploy/infer-passthrough/bootstrap.py deploy/infer-passthrough/check-health.mjs deploy/infer-passthrough/production-deployment.mjs deploy/infer-passthrough/*.service deploy/infer-passthrough/*.timer /usr/local/libexec/infer-passthrough/
git rev-parse HEAD > /usr/local/libexec/infer-passthrough/release.sha
chmod 0644 /usr/local/libexec/infer-passthrough/release.sha
install -o root -g root -m 0644 deploy/infer-passthrough/infer-passthrough-bootstrap.service /etc/systemd/system/
systemctl daemon-reload
```

Install this exact sudoers rule with `visudo -f
/etc/sudoers.d/infer-passthrough-bootstrap` (root:root, 0440), replacing
`gateway-runner` with the dedicated runner account **once**:

```sudoers
gateway-runner ALL=(root) NOPASSWD: /usr/bin/systemctl start infer-passthrough-bootstrap.service
```

No wildcards or caller-supplied arguments are permitted. Only this entry point
gets root. Repository install/build and service execution remain unprivileged.
A repeated successful bootstrap is a no-op; it does not restart, clone, or fetch.
A failed bootstrap retains backups, restores the old unit/drop-ins/env/routes
and prior link, and permits retry without manual cleanup. Power loss/SIGKILL
cannot run rollback: inspect retained `bootstrap-*` backups before retrying.

### Prerequisites and credential blocker

Linux/systemd, Python 3, git, Node **22 or 24**, and pnpm **9** are required.
The bootstrap confirms versions; it does not install packages or run dependency
code as root. It creates the `imajin` system account if absent. Verify binaries
using the **unit's PATH**, including Ubuntu's `/usr/sbin/runuser`:

```bash
env PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin sh -c 'command -v node pnpm python3 git systemd-run runuser flock'
```

**Blocked by [gap(kernel) #3190](https://github.com/ima-jin/imajin-ai/issues/3190),
a native child of #3039:** live `/spec` returns 404; the discoverable
`/vault/api/spec` describes seal/import/delegation and SSH signing, but no
repository-credential-to-gateway systemd consumer was found. TODO #3190 must
supply that authorized delivery and rotation path. **Do not paste, export, copy
from Actions, or manually write a GitHub token as a workaround.** The bootstrap
fails closed before host mutation if that credential is absent, empty, not
root-owned, or not mode 0600. This PR does not claim delivery is implemented.

The kernel consumer must provision
`/etc/imajin/infer-passthrough-github-token`. Both bootstrap and updater use
`LoadCredential=github-token:...`; the existing production-deployment helper
reads the value in process memory from systemd's credential directory. Require
**Deployments: read**, **Contents: read** and metadata only, **no write**,
Actions-write or administration permission. No token belongs in argv, env files,
units, logs, workflow secrets, issues or PR text. This repo is public: bare git
fetch needs no token; only the deployment API consumes the restricted credential.

### What the pushed bootstrap does

1. Confirms the trusted bundle and successful production deployment, then creates
   the account and bare repository without running package code as root.
2. Copies the running checkout (including installed dependencies, excluding
   `.env*`, git metadata and logs) into a root-owned, world-readable
   `releases/initial-v<version>-<unique>` rollback seed. It never points `current`
   at the inaccessible home checkout. Earlier seeds and releases are retained.
3. Captures **all** effective inline `Environment=` assignments in memory, merges
   them with the existing root-only app env (file values win), and removes
   `INFER_PROXY_ROUTES_CONFIG`. This retains KERNEL_BASE_URL, INFER_PROXY_HOST,
   INFER_PROXY_PORT and other inline values. No environment is printed or passed
   as a command argument. Unsupported env syntax or additional EnvironmentFiles
   fails closed rather than losing configuration. Existing app credentials stay
   in the restricted app env file; the GitHub credential never enters it.
4. Moves the routes file and old unit/drop-ins to a private `bootstrap-*` backup
   under the state directory (trash, **not deletion**), installs the trusted
   units, writes the non-secret updater port, and runs daemon-reload. The routes
   path must be directly under `/etc/imajin`; no arbitrary file move is accepted.
5. Starts the existing updater: main ancestry + production approval, unprivileged
   install/build with `TURBO_CACHE_DIR` under `releases/.turbo`, candidate mint
   health, atomic promotion, **one live restart** and live health/rollback.
   Candidate and live stop are bounded by `TimeoutStopSec=10s` and
   `KillMode=control-group`. Only then enable the service and
   `systemctl enable --now infer-passthrough-update.timer` and mark completion.

The pushed workflow, initial trusted bundle/root grant and #3190 delivery must
all be available before claiming #3171 is verified. After release, the operator
only dispatches the gated workflow and verifies WorkingDirectory, absent routes,
`/healthz`, active timer, and a no-op second invocation. Do not close #3171 or
perform /jin consent (#3172) from this PR. Missing grants require consent, not
host file edits; an unregistered MCP audience requires registration, not consent.

## Release check and diagnosis

The release check and updater use **the same mint-backed `/health` route**:

```bash
node /usr/local/libexec/infer-passthrough/check-health.mjs 8787
curl --fail-with-body --silent http://127.0.0.1:8787/health
systemctl status infer-passthrough-update.timer infer-passthrough-update.service
journalctl -u infer-passthrough-update.service -n 60 --no-pager
```

HTTP 200 means each required route has minted or holds an unexpired token; an
unregistered MCP audience is explicitly marked skipped. HTTP 503 includes failed
route IDs and typed guidance (credentials, grant, audience or connectivity), never
token/key material. Re-grant is advised only for a missing live grant. Existing
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
for the actual failure cause; no grant ID needs copying.

Tests use temporary git repositories and stubbed systemd/install commands,
without sudo, host access or real credentials:

```bash
pnpm --silent test:agent packages/openclaw-infer-passthrough/tests scripts/__tests__/infer-passthrough-*.test.mjs
```
