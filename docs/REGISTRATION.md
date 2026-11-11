# Registering an app with the kernel

An app has its own DID, registered public key, declared audiences and permission
ceilings. It calls public kernel APIs with scoped credentials, not kernel workspace
imports or another service's SQL tables. Start from
[ima-jin/imajin-app-template](https://github.com/ima-jin/imajin-app-template).
Imajin is alpha: public intake is [join the alpha or book a demo](https://jin.imajin.ai/alpha),
not a promise of unattended account or app provisioning.

The [Jin spec](https://jin.imajin.ai/jin/api/spec) documents provisioning and
operator decisions; the [auth spec](https://jin.imajin.ai/auth/api/spec) documents
registration, consent and tokens. Use these for wire schemas and errors rather
than treating this guide as a route catalogue.

## Choose the registration path

- **Operator-managed provisioning:** `apps.provision` proposes repository setup,
  registry registration and vault-backed key bootstrap. The resulting row is
  `third_party`, including apps maintained by Imajin. Nothing external happens
  until the operator approves the content-hashed proposal on `/jin`.
- **Developer-managed registration:** the template's registration flow uses a
  human session and a developer-held keypair. That API exists independently of
  the alpha site's intake. It does not grant operator-only dependencies, event
  permissions or service scopes.
- `first_party` is reserved for trusted kernel-admin registrations. It is not a
  shortcut for a template app to bypass consent or scope ceilings.

## Propose and approve

In `/jin`, provide the slug and display name. The template defaults to
`ima-jin/imajin-app-template`; an existing `sourceRepo` can be selected explicitly.
Site ownership, domain, visibility, sign-in audience and manifest declarations
are part of the proposal the operator reviews. An identity selected in the UI
is not authority by itself: preserve the verified owner and controller separately.

The proposal snapshots declarations from `imajin.app.json`, including app-owned
scopes, dependencies, emittable events, profile widgets and secret declarations.
The operator approves that exact list. A changed or unreadable manifest cannot
silently widen it during execution: correct the manifest and re-propose.

The pipeline checks the repository, mints and durably seals an Ed25519 keypair,
registers the app, establishes its signing-key grant and issues a claim code.
Optional attestation types use the app's own `<slug>/<type>` namespace. Inspect
`status`, `failedStep` and the error on failure; do not hand-register a second row
against the same provisioning ledger. Retries reuse completed work and the same
identity rather than minting another app.

A seeded placeholder registration can be retired atomically during registration
when it matches the guarded legacy-row rules. The signed retirement provenance
and tombstoned row remain. An unrelated active audience holder is an
`audience_conflict`, never silently replaced. A successful retry retains the
retirement metadata. Do not delete registry rows or clear ownership by hand.

## Repository credential setup

Creating a missing `ima-jin/<slug>` repository requires the operator's GitHub App
installation credential in the vault field `github-org-provisioning`. It is a
structured value with `appId`, `installationId` and `privateKeyPem`, not a PAT.
Use the protected admin vault input with delegation-grant custody; never paste
private material into a command, chat, issue, manifest or Actions secret.

The provisioning App needs Administration and Contents read/write plus Metadata
read access, installed with access to the repositories it manages. An existing
public repository is checked unauthenticated first, so its existence check does
not require that credential. Manifest reads can use the installation token;
missing credentials are distinct from malformed credentials, which fail closed.
Installation tokens are short-lived and cached in memory, not persisted or logged.
Provisioning does not write GitHub Actions secrets.

## App signing-key bootstrap

The app key stays on the vault/keystore path. Provisioning never reveals it in
its result, env files or Actions secrets; new `secretsSet` results are empty.
The dedicated authenticated claim/fetch exchange is the intentional exception:
it delivers the key to the app in-process so the SDK can sign. Do not print its
response or confuse the claim code with the private signing key.

1. After approval, capture the one-time claim-code reveal securely. Only its hash
   is retained; status polling does not reveal it again. It expires in about
   fifteen minutes.
2. Configure `IMAJIN_KERNEL_URL`, the returned `IMAJIN_APP_DID` and the temporary
   `IMAJIN_APP_CLAIM_CODE`. Do not configure `IMAJIN_APP_PRIVATE_KEY`.
3. Use `loadAppSigningKey()` from `@ima-jin/auth-client`. First boot generates a
   local bootstrap keypair and stores it in `IMAJIN_APP_KEYSTORE` (default
   `./.imajin/keystore.json`, mode 0600). The claim binds its public key to the app.
4. Supply `expectedAppDid` when claiming. A mismatched DID returns 409 without
   consuming the code. Used or expired codes return 410.
5. Later boots sign a fresh nonce/timestamp challenge with the bootstrap key to
   fetch the app's signing key. Stale timestamps and nonce replay are refused.

A lost keystore needs a new operator-approved `reissueClaim: true` proposal for
the same slug. This preserves repo, app DID and signing key; redeeming the new
code replaces the prior bootstrap binding. Reissue must omit `signInAudience`:
it cannot reset the app's audience. Protect the bootstrap file as a credential.
Signed claim/fetch events contain metadata, never private keys or claim codes.

## Visibility and sign-in audience

Discovery visibility and permission to sign in are independent.
`signInAudience` is `members` by default; `anyone` allows authenticated visitors
through the app's direct consent link, even for a private app. A private app
remains absent from public directory listings. Public/unlisted apps retain their
consent behavior; internal apps do not acquire a sign-in surface.

Invalid audience values are rejected, not coerced. An omitted owner-edit field
preserves the stored value. Widening from `members` to `anyone` requires the
owner's own session/countersign; a delegate receives `AGENT_APPROVAL_REQUIRED`.
Concurrent ownership/audience changes require reloading before retry. Provision
retries cannot silently substitute another approved audience.

This setting grants no membership, scopes, service authority or installation.
Redirect URI, PKCE where applicable, registration status and consent checks still
apply. Use the app's own login handler and auth-client callback flow; exchange
the single-use code before trusting the returned subject. See the
[auth-client contract](../packages/auth-client/README.md).

## Scope ceilings and organization context

`providesScopes` declares the app's `<slug>:` vocabulary, never a platform-owned
namespace or another app's namespace. `dependsOn` names registered active
dependency audiences and approved platform scopes. Dependencies are operator-only;
developer registration and owner PATCH cannot self-grant them. Token minting
clamps scopes to the approved ceiling; verification for a dependency honors only
that dependency's approved scopes. Revoking an audience stops verification.
Owners may narrow the ceiling, not widen it in the same edit.

An app may accept group-context tokens only after the operator approves act-as.
Minting validates the human's current group authority and allowed services;
`acting_as` applies to the primary audience, not dependency audiences. Expiry
bounds membership staleness; verification rechecks the app's act-as approval.
An app using `requireSessionOrAppToken` owns records as `auth.actingAs ?? auth.did`
on that token path. Its cookie path does not interpret `x-acting-as`.
Kernel routes use their canonical `resolveActingDid`/acting-as checks instead.
Never derive an organization's ownership, handle or label from the raw personal
session, and never fall back to that personal identity after an org refusal.

## Events and callbacks

`emittableEvents` is an operator-approved exact list, empty by default.
Kernel-owned namespaces and wildcards cannot be approved. Apps authenticate as
themselves with an app-service token; user-delegated/session tokens are not app
origin authority. App events run only the `apps`-scoped notify/audit chain:
audit runs first; settlement, emission, attestation issuance and subscription
fan-out cannot be enabled by an app event. No configured chain is permission to
move money. The kernel stamps origin and audit metadata itself.

For direct notifications, both the token and current registry approval must hold
the endpoint's `notify:*` scope. Configure `@ima-jin/notify` with an
`appTokenProvider`; failure to obtain it must not fall back to internal authority.
For payments use the scoped pay contracts, not app-emitted events or shared keys.

Verify detached kernel HTTP callbacks with `verifyKernelWebhook` before parsing
or processing, pinning your own app DID as `audience`. The helper checks Ed25519
signatures, the published overlapping key set, bounded timestamps and replay
nonces. Multi-replica receivers need shared durable nonce storage and persistent
pins. Individual standalone apps own their adoption and deployments; do not
remove an existing compatibility credential until that receiver is verified.
See [kernel webhook security](security/kernel-webhooks.md).

## Declared app secrets

Manifest secret entries contain names and kinds only. Manifest sync adds slots,
not values or grants. Random kinds require a separate signed Generate action;
operator-supplied kinds require masked Set and a separate countersignature.
Load approved values into typed server-only memory before importing DB/server
modules using `createVaultBoot`; never copy them into `process.env`.
See the [author guide](app-self-secrets-author.md) and
[operator guide](app-self-secrets-operator.md).
