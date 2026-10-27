# Vault SSH deploy action
Any ima-jin repository can call `.github/actions/vault-ssh-deploy`. It reuses
`POST /api/vault/ssh-ca/sign`; it does not export the CA or use a stored deploy key.
The host must already trust the public CA and authorize the deploy principal.
Host trust deployment/rotation belongs to the host's deployment pipeline.

## Provision the public policy
An authenticated vault operator (the same authority as SSH CA mint) creates a
grant at `POST /api/vault/ssh-ca/grants`, supplying `purpose`, active `caId`,
`repository` (for example `ima-jin/example`), `repositoryId` and
`repositoryOwnerId` (positive decimal strings from GitHub's `repository_id` and
`repository_owner_id`), `environment` (`production`),
`principals` (`["deploy"]`), `forceCommand` (`/usr/local/bin/deploy`),
`allowedHosts` (`["host.example.com"]`) and `expiresAt` (a future ISO timestamp).
Do not supply `grantee` with a GitHub grant. The response includes the public
`grantId`, derived grantee and repository/environment binding. The existing
signed delegation grant binds this identity; no schema or wrapping-key change
is needed. Names are exact and case-sensitive. Reissue grants after CA rotation.
Revoke through the existing grants/revoke route; history and attestations remain.
The operator must independently confirm both GitHub IDs before granting. A
same-name replacement repository or transferred owner cannot inherit this scope.
Existing GitHub grants without IDs fail closed with an operator re-grant error:
revoke and re-grant them with the verified IDs. DID grants are unchanged.
Optionally supply `allowedRefs`, a nonempty list (maximum 64) of exact full
`workflow_ref` strings, for example
`["ima-jin/example/.github/workflows/deploy.yml@refs/heads/main"]`.
No glob matching is performed; a different filename, branch or tag is refused.
Omitting the list retains environment-policy gating.

## Consumer workflow
Replace `REVIEWED_COMMIT_SHA` with an immutable reviewed commit in this repository.
This is a single action call; no checkout or Node dependency install is required.
The variables below are public policy/configuration, **not secrets**.

```yaml
name: Deploy
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  deploy:
    runs-on: [self-hosted, linux, vault-ssh-no-swap]
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: ima-jin/imajin-ai/.github/actions/vault-ssh-deploy@REVIEWED_COMMIT_SHA
        with:
          kernel-url: ${{ vars.KERNEL_URL }}
          purpose: deploy
          ca-id: ${{ vars.VAULT_SSH_CA_ID }}
          grant-id: ${{ vars.VAULT_SSH_GRANT_ID }}
          host: host.example.com
          principal: deploy
          command: /usr/local/bin/deploy
          known-hosts: ${{ vars.DEPLOY_KNOWN_HOSTS }}
          ttl: '600'
```

The job **must name an environment** and have `id-token: write`. Protect that
environment with the repository's deployment/reviewer policies and restrict who
can edit or invoke workflows: the ruled grant boundary is repo + environment,
plus immutable repository/owner IDs and the optional workflow-ref allowlist.
The kernel verifies GitHub's RS256
signature, fixed issuer/JWKS, audience `urn:imajin:vault:ssh-cert`, temporal
claims and environment subject, and checks workflow ownership/ref and run
identity. It records verified `repository`, repository/owner IDs, `workflow` (workflow_ref),
`environment`, `runId` and `runAttempt` in the signed issuance attestation.
Caller-provided audit identity is refused. Invalid OIDC cannot fall back to a
node/session identity. The token is used only in process memory and HTTPS headers.
No GitHub credential or token is sent as a command-line argument.
Each token's `jti` can authorize at most one successful issuance, across grants,
processes and restarts. A transaction-scoped Postgres advisory lock serializes
the issuer-domain-separated SHA-256 `jti` fingerprint check with the issuance
attestation commit. No raw `jti` or token is retained. The indexed replay
projection only consults issuance history from the last 605 seconds whose
token `exp` is still live (token lifetime is capped at 10 minutes); expired
entries leave that projection automatically. There is no separate accumulating
replay cache or replay-table cleanup; immutable signed audit history remains.
Failed issuance rolls back and does not spend the token. Forged/invalid tokens
produce a fixed anonymous refusal event without trusting or retaining claims.

## Runner and cleanup contract
- Linux, Python 3, GNU `stat` and OpenSSH client (`ssh`/`ssh-keygen`) are required.
- The example's `vault-ssh-no-swap` is an operator-provisioned **self-hosted**
  label, not a standard GitHub label. GitHub-hosted `ubuntu-latest` has swap
  and fails closed; do not substitute it or disable the action's memory guard.
- `/dev/shm` must be tmpfs and **swap must be disabled**. The action fails closed
  before key generation otherwise; it never falls back to `/tmp` or the checkout.
  Use a dedicated ephemeral runner/container with sufficient tmpfs and no swap;
  prevent untrusted concurrent workloads and disable external memory snapshots.
- Automation generates Ed25519 keys (no operator key-generation command). The
  private key is mode 0600 in a random owner-only 0700 tmpfs directory. Core
  dumps are disabled; no key is put in secrets, environment files, arguments,
  outputs, caches or artifacts. Only the directory path is a step output.
- A `finally` block removes key/cert on successful deploy, SSH failure, signing
  failure and handled cancellation. An `always()` cleanup step is a second,
  idempotent cleanup path if the deploy process is killed. Abrupt runner loss or
  SIGKILL of the entire job cannot execute cleanup: ephemeral runner teardown
  destroys the non-swappable tmpfs. Do not use persistent runners without
  guaranteed job teardown; no software cleanup can survive power loss.
- Before a persistent self-hosted runner restarts, its operator-owned startup
  hook must sweep orphaned `/dev/shm/vault-ssh-*` directories **before the runner accepts any job**.
  Stop all jobs first; use a dedicated runner UID and verify each candidate is
  an owner-only directory owned by that UID, directly under verified tmpfs,
  never a symlink. Remove its contents without following links; refuse runner
  startup if cleanup fails. Never sweep while jobs are running or share that
  UID/mount with untrusted workloads. Startup cleanup supplements teardown;
  it cannot run during a crash. Workflow/action wiring is Ryan-owned.
- Failure output is mode-neutral and does not assert credentials were removed
  when preparation or cleanup itself failed. Quarantine the runner until
  teardown/startup cleanup has been confirmed.
- `known-hosts` must contain independently pinned **public host keys**. The
  action never trusts `ssh-keyscan` or disables host verification. No SSH agent,
  user/system config, password prompt, forwarding or TTY is used.
- TTL is 600 seconds by default, capped at 900 and bounded by grant expiry.
  The grant's forced command wins over the requested command. Allowed hosts
  gate issuance; OpenSSH user certificates themselves do not bind the host.
- The action is consumer-neutral. Postal is a downstream consumer, not a
  dependency or embedded deployment command.

## Verification without deployment
`pnpm --silent test:agent scripts/__tests__/vault-ssh-deploy.test.mjs` dry-runs
the action contract and actual runner implementation with tmpfs fixtures
and mocked OIDC/vault/SSH transports. On swap-free hosts an additional test
uses real key generation with the production memory guard enabled.
Swap-enabled CI generates no private keys: the default dry-run uses
non-credential fixtures and emulates the memory precondition, while separate
negative tests exercise the real swap/disk refusal guard. It checks success/failure/
cancellation cleanup, host verification and invalid configurations. The
`Vault SSH dry-run` CI workflow runs the same Python contract without OIDC
permissions, vault credentials, or host access. Kernel unit/integration tests
use freshly generated signing keys to reject forged, wrong-repo and
wrong-environment tokens and verify signed issuance identity.
