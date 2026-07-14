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
- **Chat encryption is transport-level / key-epoch, not a ratcheting E2EE protocol.** There is no
  forward secrecy or post-compromise security guarantee yet. Do not treat chat as equivalent to
  Signal-class messaging.
- **Soft DIDs are low-assurance.** Email-backed soft identities exist for low-friction onboarding.
  They are rate-limited and require email verification before a session is issued, but they are not
  a substitute for key-based (hard) DIDs for high-value actions.
- **`.fair` manifests are machine-readable commercial instructions, not legal instruments.** They
  do not by themselves establish copyright ownership, resolve disputes, or carry tax/jurisdiction
  semantics.
- **Vault-sealed secrets are node-sealed (v1), not zero-custody.** Connector credentials (GitHub PATs,
  Discord bot tokens, etc.) are encrypted with a key derived from the node's `AUTH_PRIVATE_KEY`.
  The node operator *can technically decrypt* secrets stored on behalf of users. The system is
  encrypted at rest and access-controlled, but this is NOT zero-custody. Owner-sealed
  (zero-custody) storage is a tracked hardening milestone.
- **Rate limiting is per-process.** In multi-worker deployments, in-memory limits apply per worker.
  A shared backing store is planned.

## Supported Versions

Pre-1.0: only the latest `main` and the current production deployment receive security fixes. There
are no long-term-support branches yet.
