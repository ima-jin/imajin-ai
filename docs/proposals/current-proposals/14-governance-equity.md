## 14. Governance Equity vs. Economic Equity

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/governance-equity.md`
**Related upstream:** MJN Whitepaper v0.2, Discussion #252 (Cultural DID), Discussion #269 (MJN Token Economics)
**Addresses:** Outstanding Concern 3 (Governance Equity vs. Economic Equity) — identifies the three-layer structure and the specific documentation gap

### Executive Summary

Imajin's economic model is genuinely accessible — Streams 1–4 require nothing beyond a keypair and an invite. This is real economic equity.

Governance equity is a different and unresolved question. The Network of Souls model concentrates network-level influence in the 10% who run inference. The 90% who transact, create, and participate without running AI are economically included but have no equivalent path to network-level influence.

This document does not argue the asymmetry is wrong. Epistemic authority — people paying to access your thinking — is a philosophically serious governance signal. But a design decision that is intentional and defensible must be **stated as such**. An unstated asymmetry becomes a grievance. A stated one becomes a position that can be evaluated and refined.

The prior proposals in this series have already answered the governance equity question at the **community level**. The Cultural DID specification (Proposal 13) builds a contribution-weighted governance model that is Stream 5 independent. The remaining gap is at the **network level** — between community governance and protocol governance — where Network of Souls influence operates without a formal counterbalance or explicit documentation.

### 1. The Three-Layer Governance Structure

| Layer | Mechanism | Stream 5 Dependent? | Current Status |
|-------|-----------|---------------------|---------------|
| **Community** | Cultural DID token context (contribution-weighted, attestation-based) | No — any participant earns weight through demonstrated participation | Specified in Proposal 13 |
| **Network** | Network of Souls influence (epistemic authority, query fees) | Yes — influence flows to highly-queried inference nodes | Undocumented as a design decision |
| **Protocol** | MJN Foundation governance (Swiss Stiftung) | Mechanism unspecified | Structurally separated; internal governance not yet designed |

These three layers must not be conflated. Claiming that Cultural DID governance answers the question about Foundation governance is a category error. Each layer operates on different participants, through different mechanisms, with different stakes.

### 2. The Philosophical Case for the Asymmetry — and Its Limits

**The case for epistemic authority:**
- Token-based governance (plutocracy): capital compounds, holders govern in their own interest
- Vote-based governance (majority rule): uninformed majorities can override expert minorities on technical questions
- Epistemic authority: governance weight flows to those whose thinking others value enough to pay for — a revealed-preference signal, not self-declared or purchased

The argument is coherent and defensible. It is also incomplete in four ways:

1. **Inference access problem:** Not all knowledge is expressible through personal AI queries. A community organizer who holds relational knowledge, keeps the community healthy, and shows up reliably generates value that doesn't produce inference fees. The epistemic authority model implicitly devalues tacit, relational, and care-oriented contributions.

2. **Early-adopter concentration:** The same compounding dynamic from the Org DID Vetting proposal applies here. Early Network of Souls participants accumulate query history, trust-graph depth, and inference fees before the broader network exists. By the time the 90% arrive, the 10% have already established epistemic authority that is structurally difficult to contest.

3. **Legibility asymmetry:** The network can see query counts and inference fees. It cannot see the person who quietly mentors new members, resolves conflicts before they escalate, or maintains the cultural container that makes the community worth joining. Network of Souls influence is legible to the protocol; community stewardship is not.

4. **The translation gap:** Does network-level influence (highly-queried Network of Souls nodes) translate into protocol-level decisions? If yes, the asymmetry affects the platform's evolution. If no, the asymmetry is about social influence, not governance power. The design decision is different in each case — and this question is not yet answered.

### 3. What Is Already Resolved

**Community governance — already equitable:**
The Cultural DID governance model (Proposal 13) is explicitly Stream 5 independent:
- Token context inputs: attestation count, .fair contributions, trust graph depth, activity recency
- Stream 5 participation is **not an input**
- Accessible to any Person DID meeting the Hard DID (Established) threshold — requires keypair + 90 days active participation, not personal AI
- Decays with inactivity rather than compounding with capital or compute

Every stream that generates attestations generates governance weight at the community level. This is the answer to the concern at the community layer — comprehensively.

**Protocol governance — structurally separated, mechanism unspecified:**
MJN Whitepaper v0.2 separates Imajin Inc. (reference product operator) from the MJN Foundation (protocol steward — Swiss Stiftung). The Foundation governs the DID spec, trust primitives, and settlement mechanics. What is not yet specified: the Foundation's **internal governance mechanism** — who votes, how weight is allocated, whether it connects to Network of Souls participation.

This is a planned gap, not an oversight. But if Foundation governance is built on top of the Network of Souls model, it inherits the asymmetry at the protocol level. Changes to the inference layer that benefit inference operators would have a structural governance advantage over changes that benefit everyone else. Specifying the mechanism now, while the network is small, avoids path dependency.

**The attestation layer as a cross-layer bridge:**
`auth.attestations` records all forms of participation — event attendance, .fair contributions, vouching, check-ins, education. These records feed Cultural DID governance weight. They could also feed Foundation governance weight — providing a bridge between community-level demonstrated participation and protocol-level governance voice. This is not a proposal; it is an observation that the infrastructure for a participation-based Foundation governance mechanism already exists, if Ryan chooses to build on it.

### 4. The Remaining Gap — Network-Level Influence

With community governance addressed and protocol governance structurally separated, the remaining gap is specifically at the **network level**: diffuse influence flowing from being a highly-queried node in the Network of Souls.

**Q1: Does network-level influence translate into protocol-level decisions?**

| Scenario | Implication |
|----------|-------------|
| Network influence → Foundation votes directly | Asymmetry is a governance power problem; urgently needs counterbalance |
| Network influence → social influence only, Foundation is independent | Asymmetry is real but contained; documentation resolves it |
| Currently unclear | This is the core problem — must be specified before the network grows large enough to create path dependency |

Greg's assessment: the answer is currently unclear — and that ambiguity is the core problem. Specify the Foundation governance mechanism before a cohort of highly-queried inference nodes exists and has accumulated epistemic authority.

**Q2: Should Foundation governance be separate from or built on the Network of Souls model?**

Greg's position: **separate**. The Foundation governs the protocol layer that all nodes depend on, including nodes run by participants who will never run personal AI. Protocol governance built on inference participation would make the protocol's evolution structurally dependent on Stream 5 economics.

The Foundation's governance mechanism should draw on participation across all streams — with attestation history as the primary signal, consistent with the Cultural DID governance model. This is the cross-layer bridge from Section 3.

**Q3: Three options for Foundation governance weight distribution:**

| Option | Mechanism | Status |
|--------|-----------|--------|
| A — Attestation-based (target state) | Foundation governance weight = participation-weighted query over `auth.attestations` — same model as Cultural DID token context, but across all nodes | Requires attestation layer to be live |
| B — Cultural DID delegate model | Cultural DIDs elect delegates; delegates hold Foundation council seats; Cultural DID governance weight determines delegate elections | Requires Cultural DID formation to be live |
| C — Founding team governance (current default) | Ryan + Imajin Inc. team govern the Foundation until formal mechanism is implemented | Operational; creates path dependency risk if it persists too long |

**Greg's recommendation:** Option C at launch (pragmatic, operational), with Option A as the target state once the attestation layer is live, and Option B as a bridging mechanism once Cultural DIDs exist. Document the upgrade path explicitly so Option C doesn't become permanent by default.

**Q4: Can Cultural DID governance weight carry weight in protocol-level decisions?**

Yes — and this is the cleanest bridge between layers. When Cultural DIDs elect delegates for Foundation council representation, Cultural DID governance weight determines delegate election outcomes. A Person DID with high Cultural DID governance weight in multiple communities has demonstrated cross-community trust and contribution — exactly the kind of signal that should inform protocol governance. It is community-validated, contribution-earned, and not Stream 5 dependent.

### 5. What Documentation Is Needed

This concern resolves with **documentation**, not code changes. Three statements need to appear in the whitepaper or architecture docs as explicit design decisions:

**Statement 1 — Three-layer governance:**
> "Imajin's governance operates at three distinct levels. Community governance is contribution-weighted and Stream 5 independent — any participant earns weight through demonstrated participation in their Cultural DID. Network-level influence flows through the Network of Souls model — epistemic authority accumulates in highly-queried personal AI nodes. Protocol governance is steered by the MJN Foundation — governed by [specified mechanism]. These layers are distinct. Economic participation in Streams 1–4 is fully accessible to all hard DID holders. Network-level governance influence is Stream 5 dependent. Protocol governance is [mechanism]."

**Statement 2 — Cultural DID governance equity:**
> "Cultural DID governance is explicitly Stream 5 independent. Token context — the measure of governance weight — is computed from attestation count, .fair contribution history, trust graph depth, and activity recency. Running personal AI is not an input. Any Person DID meeting the Hard DID (Established) threshold can earn governance weight in their community through demonstrated participation."

**Statement 3 — Foundation governance mechanism:**
> "The MJN Foundation governs the protocol layer that all Imajin nodes depend on. Foundation governance is [built on: participation-weighted attestation history / Cultural DID delegate elections / founding team authority with defined transition mechanism]. Network of Souls participation [does / does not] contribute to Foundation governance weight. The current governance mechanism is [X]; the target mechanism is [Y]; the transition path is [Z]."

Statement 3 is the most urgent missing piece. Once it exists, the governance equity concern can be evaluated against a stated design position rather than an implied one.

### 6. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Does network-level (Network of Souls) influence translate into Foundation governance votes? | Determines whether the asymmetry is a governance power problem or a social influence one | Must be answered and documented before Network of Souls participation is significant |
| Is Foundation governance built on attestation history, Cultural DID delegates, or founding team authority? | Determines who governs protocol evolution | Attestation-based as target; founding team as bridge; explicit transition plan required |
| What is the Foundation's transition path from founding governance to the target mechanism? | Without a stated path, Option C (founding team) becomes permanent | Must be specified now, not after the network has grown |
| Should highly-queried Network of Souls nodes have any formal governance role, or only social influence? | If formal role: counterbalance needed; if social only: documentation resolves the concern | Social influence only at the network level; attestation-based participation at the protocol level |
| Should the Foundation governance documentation address the early-adopter concentration risk explicitly? | Naming known failure modes in advance strengthens trust in the design | Yes — acknowledge the risk and the structural mitigations |

**Detecting resolution:**
This concern resolves when the following appear in the repo or in public documentation:

- Whitepaper gain a section explicitly mapping the three governance layers and their Stream 5 dependency
- Cultural DID documentation states that token context is not Stream 5 dependent (can be added to Discussion #252)
- MJN Foundation governance mechanism is specified — even provisionally, with an explicit transition path documented
- The relationship between Network of Souls influence and Foundation governance decisions is stated explicitly in whitepaper or governance documentation

---

