# Imajin integration guide

For public copy, use the canonical [positioning](POSITIONING.md); change it there first.

Imajin supplies identity, relationships, attribution and payments through JSON over HTTPS. You can use the public contracts from any language; the published SDK supplies app sign-in and session helpers. This guide explains how to choose an integration flow, while each service's live spec defines its requests, authentication and errors.

## What you integrate with

The kernel serves **Attestation · Communication · Attribution · Settlement · Discovery · Revocation** and their shared rails. Identity is their subject. Apps built on Imajin register separate identities and own their code and deployment; they do not import kernel internals or read another service's tables.

The [concise agent entry point](../apps/kernel/public/llms.txt) and [full integration guide](../apps/kernel/public/llms-full.txt) link the kernel's defined service specs. A spec is a contract, not a deployment inventory or a permission grant. Substitute your node's origin where appropriate. Independently owned apps publish their own API and setup documentation.

## Choose your identity context

People, agents and groups have distinct DIDs. Key-backed registration verifies Ed25519 proof and derives the DID from public-key bytes. DFOS linking is separate and optional; the DID string is not a wallet address or proof of external-chain verification.

Soft identities support low-assurance onboarding under each service's policy but have no actor signing key. Verified email onboarding and soft identity resolution are not interchangeable: a resolver response does not itself set a browser session. Standing tiers are soft, preliminary, established, steward and operator; route-specific checks still decide access.

For a human acting as a business or organization, preserve the selected `x-acting-as` context. The server checks current membership, role and allowed services. Names, handles, ownership and defaults must follow the verified effective DID, not the raw personal session. An org refusal must not fall back to a personal action.

An agent authenticates with its own identity and credentials. Assignment establishes whom it serves; capability grants and live checks establish authority. Personal create, org provisioning and orphan adoption have distinct proof requirements. See the [auth spec](https://jin.imajin.ai/auth/api/spec).

## Register an app and sign in

Start with the [app template](https://github.com/ima-jin/imajin-app-template) and [registration contract](REGISTRATION.md). Declare only required scopes. App discovery visibility and sign-in audience are independent: a private app can let anyone consent without making those people organization members. The owner controls widening that audience; a delegate cannot silently widen it.

Use the published [auth-client SDK](../packages/auth-client/README.md). External packages use `@ima-jin/*`; workspace imports use `@imajin/*`. A package's private manifest flag is not evidence of publication status.

1. Configure the app's registry ID, DID, kernel URL and full public URL, including its basePath.
2. Begin login at the app's own handler so it creates isolated state before kernel consent.
3. Forward root callback parameters before claim/login gates and keep the registered callback unchanged.
4. Verify callback state and exchange the short-lived single-use authorization code using the app's signing key.
5. Establish the app session only from the kernel-returned subject and attestation, not client-supplied profile fields.

Use the same app DID for session readers and handlers. App cookies are isolated from each other and from the reserved kernel session cookie. Human session cookies are host-only by default; cross-app scoped tokens are a separate mechanism. Do not solve cross-app sign-in by copying the kernel cookie or weakening consent.

## Call services with the right authority

Use a user-delegated token for consented user operations. Use an operator-approved app-service token for the documented machine operations. Registration, operator approval, user consent and agent delegation are separate gates. A human-session-only route does not accept an app credential merely because it names the same DID.

Fetch the owning service spec for request schemas, required scopes and refusal behavior. Internal service keys, cron endpoints and development previews are not public integration shortcuts. Handle expiry, revocation, validation, rate limits and denied act-as as normal outcomes without retrying under another identity.

For app secrets, manifest sync adds declaration slots only. Generation or masked operator input needs a separate countersignature before a value is granted. Runtime adoption loads approved vault credentials into typed server-only configuration before dynamically importing database or server modules. Never put credentials in manifests, client bundles, chat or logs. See the [author](app-self-secrets-author.md) and [operator](app-self-secrets-operator.md) guides.

## Attribution and payments

A `.fair` sidecar describes contributors, attribution and economic distribution. Creative credit and payout shares are distinct. Use the [shared package](../packages/fair/README.md) and [canonical patterns](guide/canonical-patterns.md), rather than copying an illustrative manifest or fee chain.

A manifest is not evidence that payment completed. Settlement and signature-verification behavior depend on the funding path and entry point. Protocol, platform, node, buyer, scope, tax and processor handling must be read in the chosen flow; there is no universal two-percent fee or unconditional rejection of every unsigned manifest.

MJN is receipt-backed and withdrawable subject to the receipt currency and rail rules. MJNx is emitted for in-platform use and is not withdrawable. Accepted-unit checks reject unsupported units rather than converting them silently. An on-chain rail or token launch is not implied by the use of Ed25519.

For payment requests, party eligibility and control of the selected payer are distinct. Human organization owner/admin authority requires pay-service access. The authenticated human, effective caller and settlement payer have separate attribution. Card checkout and receiver-confirmed EMT follow their own contracts. Apps such as events own their checkout/ticket flows and documentation.

See the [pay spec](https://jin.imajin.ai/pay/api/spec) and [whitepaper](mjn-whitepaper.md).

## Connections and provider access

People connect providers on their profiles; apps inspect safe status and invoke authorized kernel actions. Apps do not receive provider secrets or duplicate connector lifecycle.

Organization-held keys are write-only, including for the loading administrator. Human owner/admin act-as with connections-service access controls loading, revocation and member grants. Human members need active grants; assigned agents use their verified principal relationship. Current assignment, membership, allowed services and revocation are checked per call.

Member-held Postman access is personal, with a fixed target and reviewed saved-data reads. App-hosted upstreams declare exact destinations and permissions; connecting credentials does not grant app authority without member consent. Writes have a separate scope ceiling and reason requirement. Permission-set changes require reconnection.

Org-tagged connections remain subject to retained administrative suspension before custody access; personal untagged use is separate. Membership removal revokes member grants and persists suspension. Rejoining, reconnecting and retagging do not restore revoked authority.

Successful upstream calls and authorized upstream failures have signed outcome metadata. Admission and permission refusals write nothing permanent. Credentials, request bodies and raw provider errors are not audit output. See the [connections spec](https://jin.imajin.ai/connections/api/spec) for limits and wire details.

## Agent and inference integration

Use the calling agent's own credentials and explicit principal grants. Discover usable models and safe route diagnostics from the [inference contract](https://jin.imajin.ai/infer/api/spec), rather than assuming every loaded connector is callable. Configuration metadata for a tool connector does not prove its tool authority.

The [passthrough package](../packages/openclaw-infer-passthrough/README.md) and [host runbook](../deploy/infer-passthrough/README.md) define gateway transport and auth-mode declaration. An identity selector never grants key access; do not fall back to a gateway credential after agent refusal.

Incurred usage is the kernel's meter, not a complete provider invoice. Provider-billed reconciliation needs its own sealed billing credential and scope. Missing cost is not proof of free use. The [usage spec](https://jin.imajin.ai/usage/api/spec) defines both views.

## Communication, proof and private data

Signed records prove their documented assertion and signer, not every claim an application attaches to them. Node-witnessed actions are not actor-key signatures. Preserve the proof model, current disclosure policy and revocation state.

Chat uses TLS in transit and stores plaintext at rest on the hosting node in `chat.messages_v2.content`. Push notifications carry the first 200 characters of the message preview. Message encryption is planned but not implemented; public key bundles do not protect current stored messages. No forward-secrecy or post-compromise guarantee is made. Read the [chat spec](https://jin.imajin.ai/chat/api/spec) and [security disclosures](../SECURITY.md).

Legal-entity fields use independent release policy and dedicated consumer reads. Financial identifiers are individually sealed, with non-secret references in private documents. Generic media or vault permission does not reveal them. Human-session and service-scoped organization authorization still apply. See the [auth spec](https://jin.imajin.ai/auth/api/spec).

## Run a node or contribute

The repository is source-available under the [Imajin Network License](../LICENSE.md). Run the kernel locally using [contributor setup](DEVELOPER.md). Independently owned apps use their own repositories, build commands and deployment procedures.

Kernel registration uses a signed node attestation and approved build, not an arbitrary caller-supplied DID/hostname pair. Consult the [registry spec](https://jin.imajin.ai/registry/api/spec). Internal corpus sources require registry-resolved ownership, explicit grants and that owner's OAuth connector; see the [corpus runbook](../apps/corpus/README.md).

For operational setup, use [environment configuration](ENVIRONMENTS.md), [deployment](../deploy/README.md), [deploy posture](ops/DEPLOY-POSTURE.md) and the [SSH deploy contract](deploy/vault-ssh-deploy.md). Source code and fixture tests do not establish production rollout or host trust.

Contributor CI and Sonar requirements are in the [root README](../README.md#sonarcloud-on-fork-prs). A successful compatibility skip is not a scan; check the actual analysis and quality gate on the exact head.
