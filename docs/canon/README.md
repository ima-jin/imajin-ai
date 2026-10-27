# Canon

Thesis-weight positions that shape Imajin's design. These aren't build tickets. Each file carries its source issue faithfully, with Ryan's own words verbatim where they're quoted, and links back to that issue.

Ruled 2026-10-26 (pre-cut issue audit v0.8.28, card 11, option c): canon lands here now. The corpus will read `docs/canon/` as a source later.

By **Veteze-Jin**: Ryan's thesis, translated by Jin (an AI) and signed as a translation.

This directory is the one home for Imajin canon. Start here.

## Map

| Layer | Where | What it is |
|---|---|---|
| Whitepaper | [../mjn-whitepaper.md](../mjn-whitepaper.md) | The MJN protocol thesis, end to end. Stays at `docs/mjn-whitepaper.md` because the kernel's `/whitepaper` page and a copy test read that path at runtime. |
| RFCs | [rfcs/INDEX.md](rfcs/INDEX.md) | Numbered protocol specs (RFC-01 onward). Moved here from `docs/rfcs/`; a redirect README stays at the old path. |
| Carried canon issues | [the table below](#carried-canon-issues) | Thesis-weight positions carried from GitHub issues, verbatim. |
| Architecture decisions | [../adr/](../adr/) | ADRs: one decision per file. |
| Wire contracts | [../loops-rail-contract.md](../loops-rail-contract.md), [../notify-operator-approvals-contract.md](../notify-operator-approvals-contract.md) | Implementation contracts. They stay beside the code that cites them (kernel source and `api-spec/jin.yaml`). They're indexed here, not moved. |

## Carried canon issues

| Doc | Source | Thesis |
|---|---|---|
| [design(wallet): Cross-node MJNx transfer — attestation-based seat, no build](cross-node-mjnx-transfer.md) | [#2006](https://github.com/ima-jin/imajin-ai/issues/2006) | Cross-node MJNx transfer has exactly one valid trust model, and it's attestation-based. |
| [Epic: RFC-40 — Tiered Sovereign Agent Memory & Per-Principal View Isolation (hot/warm/cold, scratch→DID, shares-as-grants)](tiered-sovereign-agent-memory.md) | [#1607](https://github.com/ima-jin/imajin-ai/issues/1607) | An agent's working state shouldn't be one flat pile on one drive. |
| [Epic: RFC-39 — Verifiable Skills & the Invokable Agent](verifiable-skills-invokable-agent.md) | [#1425](https://github.com/ima-jin/imajin-ai/issues/1425) | A skill should be a signed, verifiable artifact bound to the agent that invokes it, not a loose file matched by description. |
| [RFC-42: MyTerms (IEEE 7012) as an Imajin conformance profile — verify falsifiable claim + spike](myterms-conformance-profile.md) | [#1611](https://github.com/ima-jin/imajin-ai/issues/1611) | Falsifiable claim: MyTerms (IEEE 7012-2025) can be expressed as a conformance profile of Imajin's existing trust primitives (composable gates, proof-of-history, delegation) across the trust and application layers, without new primitives. |
| [Experience report: live MCP onboarding, an agent's-eye account](live-mcp-onboarding-experience-report.md) | [#1696](https://github.com/ima-jin/imajin-ai/issues/1696) | An agent's-eye account of connecting a real MCP client to a live Imajin node (Aug 7–8, 2026). |
| [Scoped signaling — signed, revocable disclosure to a chosen trust radius (payload: asset | state | need; disclosure_mode: discoverable vs readable)](scoped-signaling.md) | [#1224](https://github.com/ima-jin/imajin-ai/issues/1224) | Scoped signaling: a sovereign human authors a scoped, revocable, signed disclosure to a chosen trust radius. |
| [epic: DFOS chain strategy — federated data across the Imajin network](dfos-chain-strategy.md) | [#555](https://github.com/ima-jin/imajin-ai/issues/555) | Every meaningful piece of data on Imajin is portable. |
| [design: protocol-fee distribution model (dev / community / protocol residual + governance)](protocol-fee-distribution.md) | [#1306](https://github.com/ima-jin/imajin-ai/issues/1306) | Two layers that got conflated have to stay separate: the per-transaction fee cascade, decided by each asset's atomic .fair file, and protocol-fee distribution across dev, community and protocol reserve. |

### Overlaps with the RFCs

- [myterms-conformance-profile.md](myterms-conformance-profile.md) is the issue behind [RFC-42](rfcs/RFC-42-myterms-conformance-profile.md).
- [verifiable-skills-invokable-agent.md](verifiable-skills-invokable-agent.md) is the epic behind [RFC-39](rfcs/RFC-39-verifiable-skills-invokable-agent.md).
- [tiered-sovereign-agent-memory.md](tiered-sovereign-agent-memory.md) calls itself "RFC-40", but [rfcs/RFC-40](rfcs/RFC-40-did-imajin-resolution.md) is DID resolution. The issue title is carried verbatim, and the number collision is still open.
