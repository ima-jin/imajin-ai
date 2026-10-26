# Security Policy

Imajin (the MJN Protocol and its reference services) is pre-1.0, single-operator software under
active development. Think of it as sovereign plumbing — public infrastructure for running a
community, an event, an identity, a settlement layer — not a finished, hardened product.

We keep the repository public and publish a detailed technical reference (`llms-full.txt`), which
means our attack surface is documented in the open. That's deliberate. We are not claiming to be
unhackable; we are claiming to be honest about where we are. Publishing our limitations alongside
our design makes us a less interesting target than a project that overstates its guarantees, and it
lets the people who depend on us tell us where to focus our energy and spend as we scale.

This policy explains how to report issues responsibly and what guarantees do — and do not — exist
today.

## Reporting a Vulnerability

**Email:** ryan@imajin.ai
Please include "SECURITY" in the subject line.

If you need to share sensitive details, request a PGP key in your first message and we will provide
one before you send specifics.

**Please do:**
- Give us a reasonable description and, where possible, a proof of concept or reproduction steps.
- Allow time to investigate and remediate before any public disclosure.

**Please do not:**
- Run automated scanners against the production hosts (`*.imajin.ai`) in a way that degrades service.
- Access, modify, or exfiltrate data that is not your own.
- Disclose the issue publicly before we have had a chance to respond.

### Response targets (best effort)

This is currently maintained by a single operator, so these are goals, not contractual SLAs:

| Stage | Target |
|-------|--------|
| Acknowledge receipt | within 3 business days |
| Initial assessment | within 10 business days |
| Fix or mitigation plan | depends on severity; critical issues prioritized immediately |

We are happy to credit reporters in release notes unless you prefer to remain anonymous.

## Scope

**In scope:**
- The kernel services and reference apps in this repository (`apps/*`, `packages/*`).
- The public endpoints under `*.imajin.ai`.
- Authentication, session handling, identity/DID signing, settlement, and `.fair` attribution logic.

**Out of scope:**
- Third-party services we depend on (Stripe, hosting providers, etc.) — report those to the vendor.
- Social engineering of the operator or community members.
- Denial of service via volumetric traffic.
- Findings that require a compromised device or physical access the attacker already controls.

## Known Limitations (read before assuming a guarantee)

We would rather be honest about maturity than overstate it. We track these openly as issues and
close them as the work lands. As of this writing:

- **Not independently audited.** No external security audit or formal verification has been
  performed. Treat cryptographic and settlement claims as "implemented and self-reviewed," not
  "third-party certified."
- **Not fully federated yet.** Imajin can run your community — or, in principle, your country — but
  it runs as a single operator's node today. Federation (multiple independent nodes) is a roadmap
  milestone; cross-node trust and DID resolution guarantees are not yet proven at scale. There are
  real gaps here, and we name them rather than paper over them.
- **Chat uses TLS in transit, with plaintext at rest on the hosting node.** Message content is
  stored in `chat.messages_v2.content`; push notifications carry the first 200 characters of the
  message preview. End-to-end encryption (MLS with mandatory hybrid post-quantum encryption) is
  planned under [#1070](https://github.com/ima-jin/imajin-ai/issues/1070), not implemented.
  There is no forward secrecy or post-compromise security guarantee yet. Do not treat chat as
  equivalent to Signal-class messaging.
- **Soft DIDs are low-assurance.** Email-backed soft identities exist for low-friction onboarding.
  They are rate-limited and require email verification before a session is issued, but they are not
  a substitute for key-based (hard) DIDs for high-value actions.
- **`.fair` manifests are machine-readable commercial instructions, not legal instruments.** They
  do not by themselves establish copyright ownership, resolve disputes, or carry tax/jurisdiction
  semantics.
- **Vault custody is not universally zero-custody.** V1 node-sealed entries and
  v2 delegation-grant entries coexist. Tier 0 self-grants remain node-controlled;
  optional Tier 1 uses an external owner agent, but an active grant still permits
  node access. Implementation is not evidence of completed production migration.
  The sealed `bank-details:v1` API is explicitly Tier 0: fields are individually
  sealed, saves create immutable replacements, and revocation retains signed
  history. Tier 1 saves fail closed; generic media/vault access cannot disclose
  the protected fields. See the [custody runbook](docs/vault-custody-migration-runbook.md).
- **SSH certificates depend on host enforcement.** The independent in-vault CA
  never exports its private key. Operation grants bind principal, forced command,
  allowed hosts and expiry; issuance is capped at 900 seconds and grant expiry.
  Grant/CA revocation stops new issuance, not certificates already accepted by a
  host. Hosts must distribute current public trust and restrict principals.
  The GitHub deploy action binds verified OIDC to repository + environment, not
  a workflow-name allowlist. Its private job key requires non-swappable tmpfs and
  ephemeral runner teardown; pinned host keys are mandatory. See the
  [deploy contract](docs/deploy/vault-ssh-deploy.md).
- **Corpus ownership is not authority.** Registry-resolved GitHub owner groups
  require live owner-issued corpus grants. Creating an unclaimed stub or having
  membership alone grants no access. The source owner's granted OAuth connector
  is resolved server-side per operation; no node-wide token, CLI credential or
  personal-connector fallback exists. The private kernel-to-corpus credential
  transport must remain on a trusted network or TLS. See the
  [owner migration and credential runbook](apps/corpus/README.md).
- **The node key is a server secret.** `AUTH_PRIVATE_KEY` sits in the kernel's process
  environment and plays every node role at once: signing identity, vault sealing and
  delegation keys, session-token key. A kernel compromise can forge anything the node
  signs. For operator approvals that means approval forgery (the kernel's witness
  signature is the only proof in the shipped v1 model) until the operator's own
  countersignature is required (`OPERATOR_COUNTERSIGN_REQUIRED=true`, #2082 — shipped,
  off by default). Once it is required, a kernel compromise can forge timestamps and
  withhold records but can no longer forge an approval. Hardware custody is tracked in
  #1979. Role inventory and the key rotation runbook:
  [`docs/security/node-key-roles-and-rotation.md`](docs/security/node-key-roles-and-rotation.md).
- **Rate limiting is per-process.** In multi-worker deployments, in-memory limits apply per worker.
  A shared backing store is planned.

## Supported Versions

Pre-1.0: only the latest `main` and the current production deployment receive security fixes. There
are no long-term-support branches yet.
