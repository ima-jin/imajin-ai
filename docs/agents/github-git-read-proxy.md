# Agent GitHub checkouts through the kernel

This is the git-checkout companion to [OpenClaw first boot](openclaw-first-boot.md).
The box talks only to its loopback passthrough; only the kernel talks to GitHub.
No deploy key, GitHub token, `gh auth login`, or credential helper belongs on the box.

## Prerequisites

- The owner has an active primary Imajin GitHub connector with `github:read`
  enabled and its credential sealed in the kernel vault.
- The owner has issued the calling agent an active, unexpired `github:read`
  delegation grant. An audience of `all` works; a DID-limited audience must
  include the GitHub connector DID (`did:imajin:github-connector`).
- The existing agent authentication runtime supplies a short-lived, scoped
  `app+jwt` in process memory. For legacy proof-of-possession app tokens,
  `azp` is the calling agent and `sub` is the authorization issuer, not an
  identity the agent may impersonate. Its live `app.authorized` record must
  still authorize `github:read`. Consent-bound OAuth tokens retain their
  fixed agent/principal binding.
- `packages/openclaw-infer-passthrough` is already running in `authMode: agent`
  on `127.0.0.1:8787`, configured for the appropriate kernel. Agent mode
  forwards the caller's credential; it does not mint or store credentials.
  Host-static mode deliberately does not serve the git route.

This change does not install the passthrough on a real box or change the plugin.
For org-owned private repos, the owner must also have GitHub OAuth app access
approved by the repository's organization.

## Configure the checkout

The only persistent git setting is a non-secret URL rewrite:

```sh
git config --global url."http://127.0.0.1:8787/github/git/".insteadOf "https://github.com/"
```

The agent runtime must inject its existing, fresh Imajin credential into the
git **process environment**, never a command-line literal or git config file.
For a fresh shell process, with `IMAJIN_AGENT_TOKEN` already supplied securely
by that runtime:

```sh
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='http.http://127.0.0.1:8787/github/git/.extraHeader'
export GIT_CONFIG_VALUE_0="Authorization: Bearer ${IMAJIN_AGENT_TOKEN}"
git -c credential.helper= clone https://github.com/OWNER/REPO.git
git -C REPO -c credential.helper= pull --ff-only
unset GIT_CONFIG_VALUE_0 GIT_CONFIG_KEY_0 GIT_CONFIG_COUNT
```

Use a `.git`-suffixed URL. Never persist the Authorization header with
`git config`, enable shell tracing, or enable `GIT_TRACE_CURL` while carrying
a credential. The URL-scoped header above goes only to the loopback git
proxy, not to arbitrary remotes. Refresh the short-lived Imajin token through
the existing agent runtime when it expires; the GitHub token is never needed
on the box.

If the agent holds `github:read` from multiple owners, the kernel returns 409
until **each** request supplies `X-Acting-For: <ownerDid>`. Add a second
process-only config value (the DID itself is not secret):

```sh
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_1='http.http://127.0.0.1:8787/github/git/.extraHeader'
export GIT_CONFIG_VALUE_1="X-Acting-For: ${IMAJIN_GITHUB_OWNER_DID}"
```

Keep the Authorization value at index 0, and clear both values when the
process exits. The selector cannot grant authority, override a consent-bound
owner, or select an owner who has not granted this agent the scope.

## Behavior and verification

- Only smart-HTTP advertisement (`GET .../info/refs?service=git-upload-pack`)
  and fetch negotiation (`POST .../git-upload-pack`) are supported.
- Push/`git-receive-pack` is always 403, including discovery. No write request
  reaches GitHub. Other services and malformed repository paths return 400.
- Grants, capability revocations, and connector grants are checked on every
  request, including the pack request after advertisement. Existing in-flight
  transfers are bounded to 120 seconds; revocation denies the next request.
- Upstream 401/403/404 all become the same generic 404. Redirects are not
  followed or exposed. No upstream cookies or authentication challenges are
  forwarded. Packfiles are streamed with credential-reflection detection.
- A node-signed `github.git.fetch` requested-operation attestation records the
  actual actor DID, owner DID, grant reference, repository and protocol
  operation in existing attestation history before credential access. It
  records an attempt, not a claim that a transfer completed.
- Per-delegation-grant repository allowlists are **not implemented** here.
  An active grant permits reading any repository the selected owner's
  GitHub credential can read. The existing connector discovery disclosure
  allowlist is not a repository capability boundary for this route.
- Direct human requests to the kernel use the existing authenticated session
  and verified acting identity, including `x-acting-as` organization context.
  Agent requests must use the local passthrough.

For acceptance against development, use an owner-approved small private
repository: clone, advance the remote through its normal owner workflow,
pull, attempt `git push --dry-run`, then revoke the agent grant and repeat a
fetch. Record exit statuses and sanitized output only. Inspect the checkout's
`.git/config` to confirm that neither GitHub nor Imajin tokens were persisted.
Do not substitute a public-repository clone for the private-repository check.
