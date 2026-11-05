# Release deployment for infer-passthrough (#3041, #3082)
Release interlock #3230: agent-mode promotion requires an explicitly declared host auth mode after plugin PR #151 is deployed.
SIGTERM/SIGINT stops accepting requests, drains active responses, then exits 0; `INFER_PROXY_SHUTDOWN_GRACE_MS` defaults to 5000 ms (positive integer, hard cap 8000 ms; invalid values use the default), after which remaining connections/calls are cut. A second signal exits immediately. Live restart proof follows the production release (#3249).

## Calling-agent contract (#3224)

The default mode is `INFER_PROXY_AUTH_MODE=agent` (also when unset).
Every inference call carries the calling agent's **own** kernel-minted credential,
not the gateway app's token, a shared key, or a synthetic provider marker.
The sidecar never mints, caches or re-mints credentials in this mode, and never
uses a direct provider key, even during a kernel outage.

### Headers and JWT shape

- OpenAI-compatible completions (`POST /openai/v1/chat/completions`,
  `/xai/v1/chat/completions`, any `/:providerId/v1/chat/completions`, or
  `/v1/chat/completions`), model listing (`GET /:providerId/v1/models` or
  `/v1/models`), and `POST /mcp`: `Authorization: Bearer <agent-app-jwt>`.
- Native Anthropic (`POST /anthropic/v1/messages` and
  `/anthropic/v1/messages/count_tokens`): the same Bearer header, or
  `x-api-key: <agent-app-jwt>`. If Authorization is present it wins; an invalid
  Authorization never falls through to x-api-key.
- `x-acting-as: <configured-actAs-DID>` is sent by the plugin for that agent's
  configured acting identity, including org context. Omit it for personal
  context with no selector. The sidecar forwards it unchanged; it never substitutes
  route `actingAs`, `principalDid`, or `INFER_PROXY_PRINCIPAL_DID`.
- The JWT is compact, signed with EdDSA, protected header `typ: app+jwt`.
  Its `azp` is the calling agent's app DID; `sub` is its delegating principal DID.
  Both must be DIDs, and `exp` must be a future numeric Unix time in seconds.
  The existing kernel contract also carries `iss`, `aud` (normally `imajin:apps`
  for inference, the MCP resource audience for MCP), space-delimited `scope`,
  and `attestationId`. It is **not** a session JWT, `session-app+jwt`,
  `app-service+jwt`, or a new token scheme. The plugin obtains/refreshes it
  using the existing app-token flow; no key belongs in provider config.
- The sidecar checks shape/expiry only; it does not trust decoded claims as
  authorization. The kernel checks the signature, issuer, audience and scopes,
  verifies `x-acting-as` membership per call via `validateActingAs`, then
  applies its existing key-resolution and member-grant policy.
- `X-Imajin-Session`, `X-Imajin-Turn`, `X-Imajin-Run` correlation headers and
  `anthropic-version` / `anthropic-beta` remain supported. MCP session/protocol
  headers remain passthrough. The body and streamed response are forwarded
  unchanged except for the existing OpenAI parameter translation.

Provider path prefixes are transport aliases in agent mode, not identity or
authorization choices. Model selection and usable catalog policy stay in the
kernel; agent calls never consult the host principal's catalog cache.

### Refusals and errors

- Missing/malformed/expired/wrong-type JWT, a shared static key alone, or a
  malformed supplied selector: **401**, JSON
  `error: invalid_agent_credential`, with a message naming the calling agent
  credential (or its x-acting-as selector). No mint or fallback occurs.
- Kernel rejects a JWT's signature or validity with **401**: return the same
  status with `invalid_agent_credential` naming the agent credential. No retry
  under the gateway identity; the plugin must refresh its own JWT.
- Kernel **403** (including membership, scopes or required member grant) and
  other non-401 HTTP responses, including 5xx: status and body forwarded.
  A header selects, never authorizes. **On current main an org's own agent
  can still receive 403 until #3182 lands.** This PR changes no kernel
  key-resolution or org-grant policy and does not work around that refusal.
- Network failure or time-to-first-byte timeout: **502**, `upstream_unavailable`
  or `upstream_timeout`; no direct-provider/shared-key fallback.
- Unknown HTTP endpoint/method: **404**. Credentials and keys are never included
  in errors or logs.

`GET /health` and `/healthz` in agent mode are **liveness only**, return
`authMode: agent, credentialRequired: true`, and perform no mint. They do not
prove a caller's grant or completion. The deployment checker accepts this payload
only with an explicitly declared `agent` mode from the host env file (see the
release gate below); undeclared mode still requires route mint evidence.
Do not treat liveness as per-agent readiness or bypass that gate during rollout.
Live Artifact-Jin → @artifact attribution proof belongs on plugin sibling
ima-jin/openclaw-imajin-plugin#150 after both implementations ship.

### Explicit non-agent host compatibility

The static-principal implementation is **retained only for non-agent host use**,
explicitly selected with `INFER_PROXY_AUTH_MODE=host-static`. It keeps the legacy
`OPENCLAW_APP_DID`, `OPENCLAW_APP_PRIVATE_KEY`, principal routes, mint-backed health,
and optional break-glass behavior described below. Existing variables alone
**do not** enable it. Unknown mode values refuse startup.

Do not point OpenClaw agent traffic at a host-static instance. If a non-agent
host consumer still needs it, run a separate loopback instance/port; this is a
server-wide opt-in, never a request-selected escape hatch. Agent mode needs only
`KERNEL_BASE_URL` plus optional host/port/timeout settings and ignores host signing
credentials. Provider-only optional route entries need no principal in agent mode.
The shipped env example's historical app/principal fields are host-only; for
agent rollout explicitly set `INFER_PROXY_AUTH_MODE=agent`, remove provider marker auth,
and have the plugin attach the per-agent JWT and configured selector on each call.
No running host is changed by this PR. All host changes described here are
operator instructions for a reviewed release, not actions performed in this run.

## v0.8.31 release gate (#3230)

The **server default** is agent, but the **deployment gate default** is deliberately
undeclared and route-gated. `update.sh` reads only anchored
`INFER_PROXY_AUTH_MODE=` assignments from `/etc/imajin/infer-passthrough.env`,
the same EnvironmentFile used to start the candidate on :8788. It never sources
or evaluates that file and never takes the declaration from `/health` or the
updater's inherited environment. Comments/unrelated keys are ignored; the last
matching assignment wins. Use a plain unquoted `agent` or `host-static` value.
Unset or empty means undeclared. Other declared values fail with a fixed
diagnostic, without printing the value or response body; an unreadable file
also refuses the update.

- **Undeclared or host-static:** HTTP success, `ok === true`, non-empty `routes`,
  every route `ok === true`. Agent liveness without routes fails and stays frozen.
- **Declared agent:** HTTP success, `ok === true`, `authMode === 'agent'` and
  `credentialRequired === true`. A host-static route payload fails.
- The declaration is passed to candidate, live, rollback, already-current and
  `--check` probes. Redirects are refused; startup/network failures are retried
  without exposing details.

**Operator precondition before cutting v0.8.31: pick one and record which.**
These are post-PR operator steps, not actions performed by this PR:

**(a) Legacy bridge:** add `INFER_PROXY_AUTH_MODE=host-static` to
`/etc/imajin/infer-passthrough.env` before the tag. The candidate serves mint-backed
health with routes and the already-installed checker passes; **no reinstall is
needed for option (a)**. Providers keep using the shared key under the gateway
principal. This bridge does not meet "agent signs as itself everywhere".

**(b) Agent-native, in this exact order:**

1. Merge and **deploy plugin PR #151** (the implementation for plugin issue #150)
   to the gateway first: imajin-openai/imajin-xai must send each calling agent's
   own app+jwt and configured x-acting-as, not the shared static key.
2. Set the explicit line `INFER_PROXY_AUTH_MODE=agent` in
   `/etc/imajin/infer-passthrough.env`. Removing the host-static line is **not**
   sufficient: an absent declaration stays route-gated.
3. Reinstall **both checker + update.sh** from the reviewed production-approved
   artifact using the root-owned installation block below. The repo copy is
   **not live** until reinstalled to `/usr/local/libexec/infer-passthrough`;
   in particular the installed `check-health.mjs` and `update.sh` must both change.
   Do not re-run bootstrap or manually point `current`.
4. Only then let the tag promote through the existing production approval gate.

**Do not "fix" the checker alone before (a) or (b).** Unconditionally accepting
agent liveness while providers still send the shared key turns the frozen update
into 401s on every imajin-openai / imajin-xai call through :8787.
After either option, verify `journalctl -u infer-passthrough-update` shows
`deployed <tag>` and one model call through :8787 **from an agent** succeeds.
Liveness alone is not this completion proof; record the chosen option and evidence.

## Legacy host-static release deployment
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
With undeclared or host-static mode, the candidate's `/health` must mint (or cache
a valid token) for **every configured route**, except the explicitly reported
unregistered MCP audience. Break-glass cannot satisfy this probe. With explicitly
declared agent mode, the release gate above requires agent liveness instead.
The candidate is
stopped, `current` atomically switches to the release checkout, and the live unit
restarts. A second `/health` check gates success. Any post-promotion failure,
including a failed restart or TERM/INT, switches `current` back, reinstalls no
dependencies, restarts the previous code and checks rollback health. On the first
bootstrap, there is no prior release checkout: bootstrap instead restores the
saved unit/drop-ins (including the original WorkingDirectory), env and prior
link text, and restarts that service only if promotion changed its invocation. A failed
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
entry point on the dedicated `infer-passthrough-gateway` host runner. The runner
must have the organization-level runner-group restrictions below before the
narrow sudo rule is usable by automation.
Do not dispatch it from a feature branch or install a mutable checkout as root.

### Required runner-group boundary (operator setup and verification)

Register the self-hosted gateway runner at **organization level**, not repository
level: a repo-level runner cannot be placed in a restricted organization group.
In **Org settings → Actions → Runner groups**, create/select its dedicated group:

- Repository access: **Selected repositories**, containing **only
  `ima-jin/imajin-ai`** (`visibility: selected`). Other repositories must not see it.
- Workflow access: enable **Selected workflows** (`restricted_to_workflows: true`)
  and allow **exactly** this one entry, with no other branch, tag or workflow:
  `ima-jin/imajin-ai/.github/workflows/infer-passthrough-bootstrap.yml@refs/heads/main`.
- Disable public-repository access (`allows_public_repositories: false`); do not
  permit public-repository or fork pull request jobs.
- Place the gateway runner in this group only, never the default or another
  unrestricted group. The `infer-passthrough-gateway` label alone is not access
  control.

**The runner group is the real control.** An environment gates only a job that
names it; without the group, a branch workflow could omit `environment:` and
reach the same NOPASSWD command. Keep the `production` environment restricted to
main and `v*`, required reviewer `veteze`, and no admin bypass. The workflow's
first step also compares `github.ref` and `github.workflow_ref` (passed through
`env:`, never interpolated into shell code) against main and the exact selected
workflow. This is a **second layer only**: a branch copy could remove that step,
so it cannot replace the runner-group restriction.

The operator runs these **read-only** verification calls once; this PR does not
run them or claim the group exists. Replace `<id>` with the group's numeric ID:

```bash
gh api orgs/ima-jin/actions/runner-groups
gh api 'orgs/ima-jin/actions/runner-groups/<id>/repositories'
gh api 'orgs/ima-jin/actions/runner-groups/<id>/runners'
```

From the first response, find the group and confirm `visibility` is `selected`,
`allows_public_repositories` is false, `restricted_to_workflows` is true and
`selected_workflows` contains exactly the single full workflow entry above.
The repositories response must contain only `imajin-ai` under owner `ima-jin`.
The runners response must contain the gateway runner. Using the IDs from the
first response, repeat the runners call for every other group and confirm that
the gateway runner ID appears in none of them. Record that operator evidence
before dispatch; labels and a prose assertion are not sufficient.

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
install -o root -g root -m 0644 deploy/infer-passthrough/bootstrap.py deploy/infer-passthrough/*.mjs deploy/infer-passthrough/*.service deploy/infer-passthrough/*.timer /usr/local/libexec/infer-passthrough/
git rev-parse HEAD > /usr/local/libexec/infer-passthrough/release.sha
chmod 0644 /usr/local/libexec/infer-passthrough/release.sha
install -o root -g root -m 0644 deploy/infer-passthrough/infer-passthrough-bootstrap.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/infer-passthrough/infer-passthrough-deployment-read.service /etc/systemd/system/
systemctl daemon-reload
```

Install this exact sudoers rule with `visudo -f
/etc/sudoers.d/infer-passthrough-bootstrap` (root:root, 0440), replacing
`gateway-runner` with the dedicated runner account **once**:

```sudoers
gateway-runner ALL=(root) NOPASSWD: /usr/bin/systemctl start infer-passthrough-bootstrap.service
gateway-runner ALL=(root) NOPASSWD: /usr/bin/systemctl start infer-passthrough-deployment-read.service
```

No wildcards or caller-supplied arguments are permitted. Only this entry point
gets root. Repository install/build and service execution remain unprivileged.
A repeated successful bootstrap is a no-op; it does not restart, clone, or fetch.
A failed bootstrap retains backups, restores the old unit/drop-ins/env/routes
and prior link, and permits retry without manual cleanup. Power loss/SIGKILL
cannot run rollback: inspect retained `bootstrap-*` backups before retrying.

### Prerequisites and kernel deployment-read delivery

Linux/systemd, Python 3, git, Node **22 or 24**, and pnpm **9** are required.
The bootstrap confirms versions; it does not install packages or run dependency
code as root. It creates the `imajin` system account if absent. Verify binaries
using the **unit's PATH**, including Ubuntu's `/usr/sbin/runuser`:

```bash
env PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin sh -c 'command -v node pnpm python3 git systemd-run runuser flock'
```

Discovery: `/vault/api/spec` (source `apps/kernel/api-spec/vault.yaml`), not
`/spec`. The consumer composes `POST /api/vault/import` with the existing
delegation list/fetch/ack endpoints. There is no new fetch surface, SSH channel,
or parallel secret store.

The operator imports the credential **only through the paste-once vault form on
/jin**. Select the authorized owner (personal or acting-as organization),
consumer = the gateway recipient DID, purpose =
`infer-passthrough/github-deploy-read`, and a future expiry. The server binds the
repository to `ima-jin/imajin-ai` in the human-countersigned proposal. Require
**Deployments: read**, **Contents: read** and metadata only, **no write**,
Actions-write or administration permission. No token belongs in argv, env files,
units, logs, workflow secrets, issues or PR text. This repo is public: bare git
fetch needs no token; only the deployment API consumes the restricted credential.
The operator verifies fine-grained GitHub permissions at issuance; vault scope
cannot reduce an overprivileged provider token. Rotation uses the existing
import card's `replacesField` path, never an extra active credential.

The trusted host bundle has public policy in root-owned, non-group/world-writable
`/etc/imajin/infer-passthrough-deployment-read.json`: `kernelOrigin` (HTTPS origin
only), `kernelPublicKey` (pinned Ed25519 hex public key), `repository`
(`ima-jin/imajin-ai`), `ownerDid`, and `recipientDid`. Kernel public policy is
`INFER_DEPLOY_READ_OWNER_DID`, `INFER_DEPLOY_READ_RECIPIENT_DID`, and
`INFER_DEPLOY_READ_RECIPIENT_PUBLIC_KEY`. The recipient DID is derived from its
registered public key using the existing `did:imajin:<first-16-hex>` convention.
Missing policy fails closed; no owner or recipient defaults exist.

The gateway must already have its own vault-provisioned Ed25519 signing seed in
root:root 0600 `/etc/imajin/infer-passthrough-identity`. This is a narrow recipient
identity, not a GitHub credential or an operator/broad agent token. Provision
identity material only through the kernel's vault/provision/seal tools; never
generate a seed in a shell, print it, or transfer it over SSH. This consumer
does not create a replacement identity or widen SSH CA/service-at-boot custody.
Host identity custody and public trust configuration are infrastructure
prerequisites; they are not manual deployment-token provisioning.

After the existing `production` environment approval and exact-main workflow
guard, the dedicated gateway runner starts the fixed
`infer-passthrough-deployment-read.service`, then bootstrap. Both services use
only their explicit `sudo -n systemctl start ...` grants; neither checks out or
executes a caller's code as root. A later approved dispatch re-delivers/rotates
without interactive sudo, a copied grant ID, or a service restart.

Delivery discovers the recipient's exact-purpose grant, signs each request
with its own DID, and accepts only kernel-signed encrypted responses. The
shared `deployment-read-protocol.mjs` specifies canonical signed bytes:
domain-separated method/path/query/body hash, repository, owner, recipient,
purpose, random nonce, timestamp and fresh X25519 ephemeral public key. Requests
expire after 60 seconds. Replies are AES-256-GCM encrypted under a
domain-separated X25519/HKDF-SHA256 key and Ed25519 signed by the pinned kernel.
Replaying a captured signature cannot decrypt a response without the original
ephemeral private key. TLS redirects, arbitrary origins and oversized replies
are refused; no response or upstream exception is logged.

The trusted service, bootstrap and updater serialize delivery with the same
OS-released `flock` at
`/run/imajin-infer-passthrough-credential/delivery.lock`. Systemd creates its
root-owned 0700 runtime directory for all three consumers, preserves it between
invocations, and recreates it after reboot. No shared writable lock directory
is trusted. A failed concurrent delivery cannot restore bytes over a successful
rotation. Every credential-consuming host unit disables core dumps.
The root consumer writes a unique exclusive 0600 temp file beside
`/etc/imajin/infer-passthrough-github-token`, sets root:root ownership, fsyncs,
atomically renames and fsyncs the directory, then acknowledges the fetch through
the existing ack route. On ordinary write/ack failure it restores the previous
bytes from memory (or removes a failed first install); no plaintext backup is
kept. Power loss may leave a restricted temp file or an installed but unacked
file; re-delivery is safe. The import timeline retains the unmatched-fetch alert
until ack succeeds. Persisted metadata-only fetched/acked attestations and signed
response envelopes provide provenance; no database history is deleted.

Both bootstrap and updater retain `LoadCredential=github-token:...`. Delivery
must precede bootstrap because systemd loads credentials before starting it.
Absent/empty/unsafe credentials still fail closed. The production-deployment
helper additionally refreshes the vault authority on **every** deployment check
and uses the fresh value in process memory, never a stale systemd snapshot:
expired/revoked authority or unavailable vault means no deployment lookup or
promotion, even if an older credential file remains. There is no env/file
fallback, manual/interim token input, SSH copy or Actions-secret workaround.
No live host operation or production proof is performed by these tests.

### What the pushed bootstrap does

1. Confirms the trusted bundle and successful production deployment, then creates
   the account and bare repository without running package code as root.
2. Does **not read, copy or walk the running home checkout** or widen any of its
   file modes. Its rollback target is the saved unit/drop-ins and their original
   WorkingDirectory, not a copied seed. The first `current` is created only from
   the updater's verified-tag release after candidate mint health passes.
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
5. Invokes the trusted updater's internal `--bootstrap` mode, inheriting the
   bootstrap unit's `LoadCredential` and passing only the non-secret health port:
   the same main ancestry + production approval guard, unprivileged
   install/build with `TURBO_CACHE_DIR` under `releases/.turbo`, candidate mint
   health, atomic promotion, **one live restart** and live health/rollback.
   Candidate and live stop are bounded by `TimeoutStopSec=10s` and
   `KillMode=control-group`. Only then enable the service and
   `systemctl enable --now infer-passthrough-update.timer` and mark completion.
   This mode needs no pre-existing `current`. If first promotion fails, the
   bootstrap transaction restores the prior unit/WorkingDirectory and link text;
   regular timer updates still require `current` and retain release-to-release
   rollback. Do not invoke this internal first-install mode by hand.

The operator checklist before dispatch is: manually verify/install the reviewed
bundle and narrow root grant; verify the **Org settings → Actions → Runner groups**
boundary and all three read-only checks above (repo-only, exact selected main
workflow, no public/fork PR jobs, gateway in no other group); then arrange #3190
credential delivery. Neither that group nor a bootstrapped host is claimed here.
These prerequisites must all be available before claiming #3171 is verified. After release, the operator
only dispatches the gated workflow and verifies WorkingDirectory, absent routes,
`/healthz`, active timer, and a no-op second invocation. Tracker #3171 and
operator consent #3172 remain pending their post-release host proofs. Missing grants require consent, not
host file edits; an unregistered MCP audience requires registration, not consent.

## Release check and diagnosis

The release check and updater use **the same `/health` route and declared-mode
gate**. Prefer the installed updater's `--check`, which reads the host env file.
Direct checker use must pass the same explicitly declared mode as its second
argument (omitting it is undeclared/route-gated):

```bash
/usr/local/libexec/infer-passthrough/update.sh --check
# Only after option (b)'s plugin deploy, env edit and reinstall:
node /usr/local/libexec/infer-passthrough/check-health.mjs 8787 agent
curl --fail-with-body --silent http://127.0.0.1:8787/health
systemctl status infer-passthrough-update.timer infer-passthrough-update.service
journalctl -u infer-passthrough-update.service -n 60 --no-pager
```

In host-static mode, HTTP 200 means each required route has minted or holds an unexpired token; an
unregistered MCP audience is explicitly marked skipped. HTTP 503 includes failed
route IDs and typed guidance (credentials, grant, audience or connectivity), never
token/key material. Re-grant is advised only for a missing live grant. Existing
fallback and passthrough-error counters remain on both `/health` and `/healthz`.
The release checker only contacts the fixed loopback `/health` endpoint and
refuses redirects; its port argument cannot supply a host or path.
In agent mode, HTTP 200 is liveness only (`ok: true`, `authMode: agent`,
`credentialRequired: true`), not proof of a grant or successful model call.
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
