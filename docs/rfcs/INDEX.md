# Imajin RFCs

Canonical location for all Imajin protocol and architecture RFCs. Each RFC has a corresponding [GitHub Discussion](https://github.com/ima-jin/imajin-ai/discussions) for community input.

## Corpus Status Legend

Triage performed 2026-09-03 per [#1852](https://github.com/ima-jin/imajin-ai/issues/1852), reconciling the corpus against the six identity primitives (Attestation, Communication, Attribution/.fair, Settlement, Discovery, Revocation), ARM, the conformance rebuild, and the identity-primitives manual.

- **Current** — reflects present canon; keep as-is.
- **Stale (load-bearing)** — the underlying primitive is still in active use, but this spec predates its current shape; needs revision or a successor RFC. See the RFC's own front matter (`Canon`, `Tracked-in`) for detail.
- **Superseded** — retired. The file is kept in place as a tombstone (never deleted) — see its front matter for `Superseded-by` and `Reason`.
- **Vacant** — number reserved, no RFC filed at this position.

| RFC | Title | Status | Discussion | Corpus Status | Canon / Superseded-by |
|-----|-------|--------|------------|----------------|------------------------|
| [01](./RFC-01-fair-attribution.md) | .fair Attribution from Commit History | Draft | [#15](https://github.com/ima-jin/imajin-ai/discussions/15) | Stale (load-bearing) | Attribution (manual Part III) |
| [02](./RFC-02-distribution-contracts.md) | Programmable Distribution Contracts | Draft | [#16](https://github.com/ima-jin/imajin-ai/discussions/16) | Superseded | Attribution / Settlement |
| [03](./RFC-03-memory-attribution.md) | Memory Attribution (HRPOS) | Stub | — | Superseded | Attribution |
| [04](./RFC-04-settlement-protocol.md) | Settlement Protocol | Stub | — | Superseded | Settlement |
| [05](./RFC-05-intent-bearing-transactions.md) | Intent-Bearing Transactions | Draft | — | Stale (load-bearing) | Settlement |
| [06](./RFC-06-identity-portability.md) | Identity Portability & Backup Nodes | Draft | — | Superseded | Discovery / Identity |
| [07](./RFC-07-cultural-did.md) | Cultural DID | Draft | [#252](https://github.com/ima-jin/imajin-ai/discussions/252) | Stale (load-bearing) | Discovery / Identity |
| [08](./RFC-08-org-did.md) | Org DID | Draft | [#253](https://github.com/ima-jin/imajin-ai/discussions/253) | Stale (load-bearing) | Discovery / Identity |
| [09](./RFC-09-application-plugin-architecture.md) | Application Plugin Architecture | Draft | [#254](https://github.com/ima-jin/imajin-ai/discussions/254) | Superseded | — *(unclear — see #1852)* |
| [10](./RFC-10-sovereign-user-data.md) | Sovereign User Data | Draft | [#255](https://github.com/ima-jin/imajin-ai/discussions/255) | Superseded | Communication / Identity |
| [11](./RFC-11-embedded-wallet.md) | Embedded Wallet | Draft | [#268](https://github.com/ima-jin/imajin-ai/discussions/268) | Superseded | Settlement |
| [12](./RFC-12-mjn-token-economics.md) | MJN Token Economics | Draft | [#269](https://github.com/ima-jin/imajin-ai/discussions/269) | Stale (load-bearing) | Settlement |
| [13](./RFC-13-progressive-trust-model.md) | Progressive Trust Model | Draft | [#271](https://github.com/ima-jin/imajin-ai/discussions/271) | Stale (load-bearing) | Identity / Revocation |
| [14](./RFC-14-community-issuance-network.md) | Community Issuance Network | Draft | [#272](https://github.com/ima-jin/imajin-ai/discussions/272) | Superseded | Identity |
| [15](./RFC-15-trust-accountability-framework.md) | Trust Accountability Framework | Draft | [#273](https://github.com/ima-jin/imajin-ai/discussions/273) | Stale (load-bearing) | Revocation / Trust |
| [16](./RFC-16-jin-workspace-agent.md) | Jin Workspace Agent Architecture | Draft | — | Superseded | — *(unclear — see #1852)* |
| [17](./RFC-17-governance-primitive.md) | Governance Primitive | Draft | [#410](https://github.com/ima-jin/imajin-ai/discussions/410) | Stale (load-bearing) | Discovery / Governance |
| [18](./RFC-18-media-revocation-and-attribution.md) | Media Revocation and Attribution | Draft | — | Stale (load-bearing) | Revocation / Attribution |
| [19](./RFC-19-kernel-userspace-architecture.md) | Kernel/Userspace Architecture | Draft | — | Stale (load-bearing) | Architecture |
| [20](./RFC-20-application-conformance-suite.md) | Application Conformance Suite | Draft | — | Stale (load-bearing) | Conformance (#1289) |
| [21](./RFC-21-imajin-conformance-suite.md) | Imajin Conformance Suite | Draft | — | Stale (load-bearing) | Conformance (#1287, #1289) |
| [22](./RFC-22-federated-authentication.md) | Federated Authentication | Draft | — | Superseded | Identity |
| [23](./RFC-23-multi-chain-settlement.md) | Multi-Chain Settlement | Draft | — | Stale (load-bearing) | Settlement |
| [24](./RFC-24-knowledge-surfaces.md) | Knowledge Surfaces | Draft | — | Superseded | Discovery |
| [25](./RFC-25-app-runtime.md) | Application Runtime | Draft | — | Stale (load-bearing) | Architecture |
| [26](./RFC-26-federated-handle-resolution.md) | Federated Handle Resolution | Draft | — | Superseded | Identity / Discovery |
| [27](./RFC-27-multi-agent-coordination.md) | Multi-Agent Coordination | Draft | — | Superseded | Communication |
| [28](./RFC-28-universal-real-world-registry.md) | Universal Real-World Registry | Draft | — | Superseded | Discovery |
| [29](./RFC-29-biometric-trust-escalation.md) | Biometric Trust Escalation | Draft | — | Superseded | Identity / Trust |
| [30](./RFC-30-the-judgment-token-thesis.md) | The Judgment Token Thesis | Draft | — | Superseded | Governance |
| [31](./RFC-31-agent-execution-sandbox.md) | Agent Execution Sandbox | Draft | — | Superseded | — *(unclear — see #1852)* |
| [32](./RFC-32-agent-protocol-interop.md) | Agent Protocol Interoperability | Draft | [#965](https://github.com/ima-jin/imajin-ai/issues/965) | Superseded | Communication |
| [33](./RFC-33-agent-ci-pipeline.md) | Agent CI Pipeline | Draft | — | Superseded | — *(unclear — see #1852)* |
| [34](./RFC-34-community-needs-brokerage.md) | Community Needs Brokerage | Draft | — | Superseded | Discovery |
| [35](./RFC-35-context-bound-connection.md) | Context-Bound Connection | Draft | — | Current | ARM / Communication |
| [36](./RFC-36-deterministic-hooks.md) | Deterministic Hooks | Draft | — | Superseded | — *(unclear — see #1852)* |
| [37](./RFC-37-corroboration-escrow.md) | Corroboration Escrow | Draft | — | Superseded | Communication / Trust |
| 38 | *No file exists* | — | — | Vacant — number reserved; see #1852 step 4 (#1319 candidate) | — |
| [39](./RFC-39-verifiable-skills-invokable-agent.md) | Verifiable Skills & the Invokable Agent | Draft | — | Current | Attestation / Agent |
| [40](./RFC-40-did-imajin-resolution.md) | `did:imajin` Resolution (Chain-Verified, Transport-Agnostic) | Draft | [#1427](https://github.com/ima-jin/imajin-ai/issues/1427) | Current | Discovery / Identity |
| [41](./RFC-41-composable-gate.md) | The Composable Gate (signed-predicate reactor primitive) | Draft — build deferred | [#965](https://github.com/ima-jin/imajin-ai/issues/965) | Current | ARM / Attestation |
| [42](./RFC-42-myterms-conformance-profile.md) | MyTerms (IEEE 7012) as an Imajin Conformance Profile | Draft — alignment/research, build deferred | — | Current | Conformance |
| [43](./RFC-43-receipt-grammar.md) | The Receipt Grammar | Draft — grammar confirmed, extraction sequencing open | — | Current | Settlement / Attribution |
