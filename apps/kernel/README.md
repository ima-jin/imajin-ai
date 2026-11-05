# @imajin/kernel

The kernel is the Next.js application implementing **Attestation · Communication · Attribution · Settlement · Discovery · Revocation** and the shared rails that serve them. It is what a node operator runs, not a registered third-party app.

Apps built on Imajin own their repositories, identities and deployment procedures: [coffee](https://github.com/ima-jin/coffee), [dykil](https://github.com/ima-jin/dykil), [events](https://github.com/ima-jin/events), [learn](https://github.com/ima-jin/learn), [links](https://github.com/ima-jin/links) and [market](https://github.com/ima-jin/market). They use the [registered-app contract](../../docs/REGISTRATION.md), published SDKs and public APIs, never kernel-internal imports or another service's tables. Broker-agent and corpus are internal services.

## Run it

```bash
pnpm --filter @imajin/kernel dev
```

The local kernel listens on port 3000 and has no basePath. Follow [contributor setup](../../docs/DEVELOPER.md) for prerequisites, environment configuration and migrations. [Environment configuration](../../docs/ENVIRONMENTS.md) and [deployment](../../deploy/README.md) describe operator procedures; source support is not proof that a host is configured.

## Identity and app integration

People, agents and groups have distinct DIDs. Human organization act-as requires live membership, role and allowed-service checks. Use the verified effective identity for ownership, names, handles and labels; a refused org action must not fall back to the personal DID.

Registered apps use user-delegated tokens or operator-approved app-service credentials. App visibility and sign-in audience are independent: a private app can admit anyone to consent without making them an organization member. Registration, operator approval and user consent do not replace one another.

App sign-in starts in the app's login handler, preserves callback state and exchanges a short-lived single-use code with proof of the app's signing key. The app session uses only the kernel-returned subject and attestation, with its own isolated cookie. See the [SDK](../../packages/auth-client/README.md).

An agent has its own DID and credentials. Organization agents use provisioning rather than the personal create flow. Orphan adoption checks live human administrator authority and original-key proof without changing the agent DID or key. Assignment describes whom an agent serves; current grants and per-operation checks determine its authority.

## Connectors and inference

People connect providers on their profiles. Apps inspect safe connected state and invoke scoped kernel operations; provider keys remain in kernel custody.

Organization-held keys are sealed under the org DID in a separate registry namespace. Human owner/admin act-as with connections-service access controls lifecycle and member grants. Values are write-only, including for the loading admin. Reads expose metadata, not secrets or generic vault export. Tier 0 remains node-controlled; unsupported external-owner loads fail closed.

Human members need active per-member grants. Assigned agents use their verified principal relationship, with live assignment, allowed-services and revocation checks per call. Membership removal revokes member grants atomically; rejoining does not restore them. Org-tagged personal connections have separate retained suspension policies; reconnecting or retagging does not clear them, and personal untagged use remains separate.

Member-held Postman access exposes reviewed saved-data reads through a fixed target. App-hosted upstreams bind member consent to exact destinations and permissions, with separate read/write authority. Credentials are injected by the kernel, not returned to the app. Consult the [connections spec](https://jin.imajin.ai/connections/api/spec) for validation, limits, metadata and audit semantics.

Inference discovery returns the caller's usable model catalogue and safe route diagnostics. The signer stays the agent even where the credential belongs to its verified principal. A configured connector is not proof of tool authority or usable custody. Alternative identity selectors require their own authorization; a selector never grants access.

The [inference spec](https://jin.imajin.ai/infer/api/spec) defines discovery and routing. The [passthrough package](../../packages/openclaw-infer-passthrough/README.md) and [host deployment runbook](../../deploy/infer-passthrough/README.md) define the separate gateway transport, auth-mode declaration and production evidence gate.

## Attribution, payments and private records

Use the [canonical patterns](../../docs/guide/canonical-patterns.md) for `.fair` construction, signature handling, settlement and disclosure. Fee and verification behavior is path-dependent; do not infer a universal fee or unsigned-manifest refusal from the presence of a sidecar. MJN and MJNx are separate ledger units, with no silent conversion.

Payment-request card checkout distinguishes party eligibility from control of the selected payer. A human owner/admin controlling the recipient org needs pay-service access. The authenticated human, effective caller and settlement payer remain separate. EMT retains its own capability and payer-control contract; it does not inherit the card party gate.

Legal-entity reads apply per-field disclosure through `getLegalEntity`. Bank identifiers are individually sealed; private documents and projections contain references and non-secret metadata. Both require the documented human-session and service-scoped owner/admin authority. Generic media/vault permissions do not disclose these records. Replacement and revocation retain signed history.

## Operator lanes

Registered-app views retain expandable expired and revoked provenance. Clear uses the registry revocation rail and retains consent history; it does not delete rows. DCR expiry applies only to eligible unused registrations, not protected provisions or claims.

Record reads personal or authorized organization history and distinguishes the actor from the subject. Grant and approval links require their own access. Switching identity clears loaded views and stale requests; absent provenance is displayed as unknown rather than inferred.

Inbox attention counts include actionable approvals. History retains resolved, expired, superseded and archived cards. Lease renewal, idle warnings and the agent's signer-scoped approvals-lease read are separate from granting authority. A transport delivery acknowledgement is not a signed command outcome.

Runs, decisions, briefs and loop events use principal-scoped recorded authority. Read the [Jin spec](https://jin.imajin.ai/jin/api/spec), [loop rail contract](../../docs/loops-rail-contract.md) and [notification contract](../../docs/notify-operator-approvals-contract.md) instead of interpreting harness-local references as public command capabilities.

App-secret sync adds declaration slots only; it does not change identity, generate values or grant secrets. Generated slots require a separate signed Generate action; operator-supplied values require masked Set and countersignature. Prior grant history prevents regeneration. Runtime adoption loads typed server-only vault configuration before database/server imports. See the [author](../../docs/app-self-secrets-author.md) and [operator](../../docs/app-self-secrets-operator.md) guides.

## Reach clients

The person-specific reach setup page and unified agent card describe available transports, credential tiers and the reach-only knock flow. Disabled reach exposes no card. An advertised DID service is a transport hint, not proof of domain ownership or authority.

A static-header client can knock for its own foreign-agent stub and recipient-bound bearer. The `onBehalfOf` description remains unverified. Save the one-time bearer in the client's protected authorization setting; there is no retrieval endpoint. It authorizes only the documented recipient and reach surfaces, not general REST, session or MCP access.

Replies and status remain scoped to that stub and audience. Revocation, expiry and sender blocking restrict use; a blocked sender receives no reply content. Sliding use never exceeds the unconditional hard cap. Fetch the recipient's reach-only spec from their published card rather than importing the whole auth contract.

## Security and operations

Chat uses TLS in transit and stores plaintext at rest on the hosting node in `chat.messages_v2.content`. Push notifications carry the first 200 characters of the message preview. Message encryption is planned but not implemented; public key bundles do not protect current stored messages. No forward-secrecy or post-compromise guarantee is made.

SSH CA lifecycle and signing use scoped vault grants, bounded certificate lifetimes and retained signed history. Hosts must enforce CA trust and principals; allowed hosts are issuance policy, not an OpenSSH destination restriction. The [SSH deploy contract](../../docs/deploy/vault-ssh-deploy.md) documents GitHub OIDC, pinned host keys and runner requirements.

Corpus GitHub partitions use registry-resolved source-owner groups and explicit owner-issued grants; workspace sources stay principal-owned. Credentials come from that owner's selected OAuth connector, not a node token or CLI login. Follow the [corpus runbook](../corpus/README.md) for deployment and separately authorized migration.

PM2 online state does not establish HTTP health. See the [liveness watchdog and deployment runbook](../../deploy/README.md) for bounded checks, operator installation and persistent restart receipts. The reviewed release pipeline and production approval gate remain mandatory.

## Reference

- [Concise agent guide](public/llms.txt) and [full integration guide](public/llms-full.txt): concepts and links to every defined service spec.
- [Security disclosures](../../SECURITY.md): trust assumptions and implementation limitations.
- [Root README](../../README.md): app/package entry points and contributor checks.
- [Deploy posture](../../docs/ops/DEPLOY-POSTURE.md): workflow ordering, evidence and ownership.
