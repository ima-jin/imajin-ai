

# Proposal 25 — Family DID


## The Missing Scope in the Identity Primitive Set

**Filed:** 2026-03-21
**Author:** Greg Mulholland (Tonalith)
**Series:** Proposal 13 of the Greg architectural review series
**Against upstream HEAD:** 40c52b7
**Relates to:** RFC-07 (Cultural DID), RFC-08 (Org DID), RFC-13 (Progressive Trust), RFC-17 (Governance Primitive), Proposal 21 (Attentional Sovereignty), Proposal 22 (Identity Archaeology), Proposal 20 (Fee Model)
**Upstream evidence:** RFC-17 specifies family governance defaults (custodial; guardians govern; age-graduated rights; fork semantics for separation and dual custody) — the governance layer exists; the identity primitive does not

---

## Why This Gap Exists Now

The 4-scopes × 5-primitives matrix has three of four identity primitives:

| Scope | DID | Status |
|---|---|---|
| Actor | `did:imajin:{id}` | Live — soft/preliminary/established tiers |
| Community | Cultural DID | RFC-07 — Discussion #252 |
| Business | Org DID | RFC-08 — Discussion #253 |
| **Family** | **Family DID** | **Unproposed — this document** |

RFC-17 describes family scope governance in detail: custodial by default, guardians govern, members gain age-graduated rights, forks are reversible, dual custody creates dual membership. Ryan specified the governance model. The identity primitive that carries it has not been proposed.

The gap is not blocking anything today. It becomes relevant when:
- A family wants shared attribution on co-created work (.fair to a family scope)
- A family wants to act as a governance unit in community formation (RFC-17: two families connecting triggers community scope)
- A family needs a scoped communication channel that is not a group chat in someone's actor-scoped app
- A parent wants to establish a dependent's identity on the network before that dependent can generate their own keypair

The governance model existing before the identity primitive is the right order. RFC-17 gave us the rules. This proposal specifies the container those rules govern.

---

## 1. What Family DID Is and Is Not

### What It Is

A Family DID is a governance-chain identity for a group of actor DIDs in a care relationship — defined by mutual responsibility and shared resources, not legal incorporation or shared cultural practice. It is the most intimate of the four identity scopes: smaller than a community, more fluid than an org, more formally governed than a connection.

A family DID enables:
- A shared identity that the family can use collectively as an author, payee, or discoverable presence
- A governance chain that records custodial relationships, shared decisions, and membership changes
- Scoped attribution — a family band's recordings, a co-written essay, a jointly built project can carry the family DID as author
- A foundation for community formation: RFC-17 specifies that two families connecting triggers the community scope

### What It Is Not

- **Not a legal entity** — a family DID has no relationship to legal kinship, marriage, or guardianship as defined by any jurisdiction. It is a trust-network construct, not a legal one.
- **Not a Cultural DID** — Cultural DIDs are communities of practice with fluid membership and no custodial relationships. A family is intimate and custodial. The membership is not fluid in the same way; the governance is not quorum-based by default.
- **Not an Org DID** — Org DIDs exist for commercial and legal entities. A family may run a business together, but the family DID is not the business — the business would be an Org DID that the family DID governs or connects to.
- **Not a group DID for friends** — the family scope requires custodial intent. A group of friends is a Cultural DID or a connection — not a family scope.
- **Not a shortcut to established-tier standing** — guardian attestations confer family-scoped standing, not network-wide standing. A person's progressive trust tier (RFC-13) remains their own and cannot be boosted by family association.

---

## 2. The Intimacy Thesis

The attention economy's sovereignty problem (Proposal 21) has an intimate-scope version: the family is the first environment where attentional habits are formed. Before a child encounters a platform, they encounter a family — a set of relationships that shapes what they attend to, how they interpret trust, what they expect from social environments.

Imajin's architecture inverts the attention market at the actor scope. At the family scope, the inversion is different: it is not about preventing external attentional manipulation — it is about providing the family with the tools to govern its own internal attentional environment. What the family agrees to share. How decisions are made when members disagree. What a member carries with them when they grow up and leave.

The family DID is the technical container for these decisions. Its privacy defaults must be the strongest of any scope — not because families are inherently private, but because the processes that happen inside them are the ones that most shape who a person becomes, and those processes must remain under the family's own governance, not subject to external visibility without consent.

The practical form of this: a family's attestation history — its internal vouches, its care records, its shared resource grants — should be encrypted and visible only to family-scope members. A node operator running the app can compute aggregates. They cannot read the family's record.

---

## 3. Formation

### Minimum Requirements

A family DID requires at least **one guardian actor DID** — a preliminary or established DID that initiates the family governance chain. Unlike Cultural DID (which requires 5–7 founding members meeting a token context threshold) and Org DID (which requires a business declaration), family formation is intentionally low-barrier. A single parent is a family. A pair of carers without a child registered yet is a family.

Formation does not require:
- Legal documentation of any kind
- Multiple established-tier DIDs
- A network covenant declaration (unlike Cultural DID)
- A minimum member count

Formation does require:
- At least one preliminary or established-tier actor DID as guardian
- A signed declaration of family scope: a governance operation on the family's identity chain (DFOS substrate, RFC-17) that asserts custodial intent
- A chosen privacy configuration: whether the family DID itself is publicly discoverable (as a presence — a family band, a shared account) or completely private (invisible to the trust graph)

### Formation Process

1. The initiating guardian generates the family DID — an Ed25519 keypair for the family scope identity, separate from any member's individual keypair
2. The guardian signs a genesis governance operation on the family chain: establishes themselves as guardian, sets initial governance defaults (custodial — RFC-17), sets privacy configuration
3. Additional guardians can be added by co-signing the family chain — each additional guardian signs a membership operation that is countersigned by the existing guardian(s)
4. Members and dependents are added by guardian governance operation (see Section 4)
5. The family DID is now active: `did:imajin:family:{id}` — carrying its own governance chain, its own keypair for signing collective actions

### Single-Guardian Families

A family DID with one guardian is valid. Single-parent families, a carer without a partner, a guardian managing a family estate alone — all are legitimate family scope initiators. The governance model is sovereign in the single-guardian case (RFC-17: 1 person = sovereign, full control). Governance weight thresholds only become relevant when additional members with standing are present.

---

## 4. Membership Model

Three roles within a family DID:

### Guardian

An established or preliminary actor DID with administrative control over the family governance chain. Guardians:
- Can add and remove members and dependents by governance operation
- Cast governance votes at full weight
- Can delegate governance to another guardian (with their consent)
- Cannot unilaterally fork — a fork from a family scope is a governance operation, not an administrative act (unless sole guardian)

Guardianship is transferable. A guardian can add another guardian and then remove themselves — by governance operation, recorded on the chain. This handles succession, separation of responsibilities, or a dependent becoming a full guardian as they age into the role.

### Member

A registered actor DID within the family scope. Members:
- Can participate in family-scope communication, attribution, and settlement (as governed by the family chain)
- Accrue governance weight through attestation-based graduation (see Section 5)
- Can see family-scope records up to their visibility tier
- Can hold and exercise governance weight — from 0 (new member with no external attestation history) up to guardian-equivalent weight as their record grows

The distinction between guardian and member is not permanent. A member who grows into full governance participation and is elevated by guardian governance operation becomes a guardian. The chain records the transition.

### Dependent

A named reference in the family governance chain who does not yet have their own actor DID. Dependents:
- Have no keypair of their own — they are represented in the chain as a reference, not as a signing party
- Carry no governance weight
- Are listed in the family chain with an optional external reference (name, description) set by the guardian — encrypted, private to the family scope
- Transition to Member when they register their own actor DID and the guardian governance operation links their new DID to the dependent reference in the chain

The transition from dependent to member is the first step in the age-graduation pathway. The chain records continuity: the member DID is the same person as the prior dependent reference.

---

## 5. Age-Graduated Rights — The Attestation-Based Graduation Mechanism

RFC-17 specifies "age-graduated rights" without naming the graduation mechanism. Calendar age cannot be the mechanism — it requires a state-issued birth certificate, which violates the sovereignty principles of the platform. The architecture does not verify legal identity; it verifies participation history.

The graduation mechanism is **attestation accumulation**, not calendar age.

### Governance Weight Thresholds

A member's governance weight within their family scope grows through three independent channels:

**Channel 1: External attestations**
Attestations from actor DIDs outside the family scope — vouches from established DIDs, event attendance, verified interactions, community standing. The logic: a person whose participation record extends beyond their family has demonstrated the kind of independent network presence that warrants governance participation in the family chain. The threshold is not high — a handful of genuine external attestations is sufficient to move from 0 to partial governance weight. The exact threshold is a governance parameter (`family.external_attestation_threshold`, configurable per RFC-17, default: 3 attestations from distinct non-family DIDs).

**Channel 2: Internal standing history**
Attestations issued within the family scope — contributions to shared projects, participation in family-scope governance decisions, verified care interactions. A person who has been an active participant in the family's internal record for a sustained period accumulates internal standing. This channel is slower and cannot fully substitute for Channel 1 — a person with only family-internal attestations has a standing history that has not been independently verified by the broader network.

**Channel 3: Self-declaration of participation**
A member can explicitly assert a claim to governance participation — signed by their own keypair, recorded on the family chain. This alone carries minimal weight. It is a signal, not a qualification. Its value is in combination: a member with external attestations + internal standing + self-declaration has demonstrated both external verification and active intent.

### Governance Weight Computation

```
family_governance_weight(member) =
  (external_attestation_score × 0.5) +
  (internal_standing_score × 0.35) +
  (self_declaration_present × 0.15)

capped at guardian_weight ceiling (default: equal to guardian weight at established tier)
```

The 0.5/0.35/0.15 weighting is a default, configurable by family governance at the structural tier (RFC-17 decision tier: 7-day vote, 1-year TTL).

A 16-year-old with three external attestations, consistent internal standing, and a self-declaration has governance weight. A 30-year-old who just joined the family chain with no external attestations has 0 governance weight. The mechanism tracks participation, not calendars.

### The Graduation Path in Practice

A dependent becomes a member when they register their actor DID. At that moment their governance weight is 0 — they are in the family chain but not yet participating in governance. As they build their external attestation record (attend events, get vouched for by people outside the family, build community standing), their governance weight grows. There is no ceremony, no formal elevation, no single moment — the weight grows with the record. The chain shows the trajectory.

The guardian can accelerate this by adding a governance attestation — a deliberate act of recognition: *this member has demonstrated sufficient participation to hold governance weight.* This is a family-scoped vouch, not a network-tier upgrade. It is recorded on the family chain, not on the member's network-tier record.

---

## 6. Shared Resources Model

The sovereign node architecture means each member keeps their own node. There is no shared family node (unless the family deliberately runs one, which is a deployment choice, not a protocol requirement). Family-scope shared resources are implemented as **TTL'd cross-node permission grants** governed by the family DID's governance chain.

### Family Settlement

A family wallet is not a shared account with a single private key. It is a governance-gated permission: one or more member DIDs hold a grant to initiate settlement operations on behalf of the family DID. The grant is:
- Issued by family governance operation (guardian or quorum, depending on governance tier)
- Scoped: the grant specifies what kinds of transactions the grantee can initiate (receive only, spend up to a threshold, full management)
- TTL'd: the grant expires and must be reissued (RFC-17: no permanent grants)
- Revocable: a guardian governance operation can revoke any grant immediately

This handles: allowances (a member DID has a recurring receive grant), shared expenses (a designated family member holds a spend-up-to grant for household costs), inheritance (a succession grant is pre-configured and activates on a governance event), joint income (a family band's .fair attribution routes to the family DID, then distributes per internal governance).

### Family Attribution

A family band. A co-written book. A jointly built piece of furniture. Any creative or economic output produced by two or more family members acting as a unit can be attributed to the family DID in the .fair manifest.

The `.fair` chain entry reads: `author: did:imajin:family:{id}`. The family DID's governance chain records how that attribution distributes internally — percentage splits, contingencies, survivor rules. External parties (the platform, the network) see the family DID as the author. Internal distribution is the family's governance concern.

This matters for the fee model (Proposal 20): the `.fair` fee chain (creator 99.25%, protocol 0.25%, host 0.25%, dev 0.25%) applies at the family DID level. The family receives 99.25% and distributes internally. The protocol does not reach into the family scope to apportion creator shares — that is family governance.

### Family Communication

Family-scope communication is a routing configuration, not a new application. The family DID keypair can be used as an addressable target: a message signed and encrypted to `did:imajin:family:{id}` is readable by all member DIDs who hold a decryption grant for the family scope. Each member retains their own keypair; the family scope is a shared address, not a shared key.

This is the correct model for the sovereign architecture: no family-scoped private key that any single party could lose or have compromised. Members hold their own keys. The family address is a routing convention backed by governance grants, not a new cryptographic secret.

### Family Discovery

A family DID can hold a shared declaration namespace — opt-in, private by default. A family that operates a shared presence (a family business's social presence, a family band's profile, a shared household listed on a community node) can publish declarations from the family DID. The family's discovery presence is governed by the family chain — any change to the family's public declarations is a governance operation.

The default is private: a new family DID has no public discovery presence. The family opts in by governance operation.

---

## 7. Privacy Defaults

Family scope has the strongest privacy defaults of any scope. These are not just recommendations — they are the defaults that ship with the protocol.

| Resource | Default visibility | Override requires |
|---|---|---|
| Family DID existence | Private — not discoverable | Guardian governance operation (explicit opt-in) |
| Membership roster | Private — family members only | Not overridable externally |
| Guardian/member/dependent roles | Private | Not overridable externally |
| Family attestation history | Encrypted — readable only by members with decryption grant | N/A — encryption is not a default, it is the architecture |
| Shared governance decisions | Private | Not overridable externally |
| Family attribution records (published work) | Public once published | Author's decision at publish time |
| Family settlement totals | Private | Not overridable externally |

The distinction in the last row matters: when a family publishes a .fair-attributed work, the attribution record is public — it has to be, because attribution is public by design. But the family's internal settlement history — what was paid to which member, what the distribution was — is private. The external world sees `did:imajin:family:{id}` as author. The internal distribution is not disclosed.

Node operators running the application can compute aggregates (how many family DIDs exist on the node, total attribution volume from family scopes). They cannot read individual family chain contents. This is the same architectural separation as the identity archaeology view (Proposal 22): `payload_hint` for aggregates, encrypted `payload` for content.

---

## 8. Fork Semantics

RFC-17 specifies the fork semantics; this section adds the implementation layer.

### Separation

A family separation (divorce, split, estrangement) is a governance fork. Two new family DIDs are created. Each member chooses their primary family DID, or holds membership in both. Attestation history is preserved in both chains — a fork does not erase what was built together.

**What happens to shared grants on fork:**
- Shared settlement grants are suspended immediately — pending ratification by each new family chain
- Each new chain must explicitly reissue grants it wishes to preserve
- In-flight .fair attributions on published work are preserved — published records are immutable
- Family discovery declarations fork with the initiating guardian's chain; the other chain starts with a clean discovery namespace

**What happens to dependents on fork:**
A dependent has no keypair of their own. They exist in the family chain as a named reference. On fork, the dependent reference is copied to both chains — dual membership by default. When the dependent later registers their own actor DID, they can choose which family chain to link to, or both. The dual-membership default reflects the dual-custody reality.

### Dual Membership

A member (registered actor DID) can hold active membership in two family chains simultaneously. This is the dual-custody case: the member's actor DID is listed in both chains, and their governance weight accrues independently in each. Standing earned in Family Chain A does not transfer to Family Chain B — family-scoped standing is local to each chain.

A member in two family chains receives family-scoped communications from both. Settlement grants are chain-specific. Attribution can name either or both family DIDs.

### Reconciliation

Two forked family chains can merge. This creates a single chain that records both fork branches and the merge event. All attestation history from both chains is preserved. Governance configuration after merge defaults to the parameters of the longer-standing chain, subject to ratification by the merged membership at the constitutional governance tier.

---

## 9. Role in Community Formation

RFC-17: a community forms when 2+ family-scoped units connect, or 7+ actor-scoped units connect. The family DID is therefore not just an identity primitive — it is a community formation unit. Two families connecting need inter-group governance that neither family's internal chain can provide. A community DID forms to handle that inter-group layer.

This has practical implications for the family DID design:

**What the family chain must expose (minimally) for community formation:**
- The family DID itself — addressable, so another family can connect to it
- A governance operation accepting a connection from another family DID
- Nothing else — the family's internal membership and governance remain private

The community that forms from two connecting families does not see inside either family. It sees two family DIDs in its governance graph. The trust graph records the connection. The families' interiors remain theirs.

**Why this threshold matters:**
RFC-17 draws the distinction: two solo actors are a connection, two families are a community. This is not arbitrary — a family already has internal governance. When two governance units connect, the inter-group layer requires its own governance. The family DID is the evidence that a governance unit exists.

A neighborhood association, a faith community, a school parent group, a cooperative housing arrangement — these are all families connecting and requiring community-scope governance. The family DID is the atom. The community DID is the molecule.

---

## 10. Matrix Placement

The family DID addresses these cells in the 4 scopes × 5 primitives matrix:

| | Attestation | Communication | Attribution | Settlement | Discovery |
|---|---|---|---|---|---|
| **Family** | Guardian attestations for members; care-relationship attestations; coming-of-age attestations (external vouch signals); family-scoped standing records | Family-scoped E2EE routing (shared address, individual keys); guardian-to-member and member-to-member channels within scope | .fair to family DID for co-created work; internal distribution governed by family chain | Shared expenses, allowances, inheritance — all governance-gated TTL'd grants; family DID as payee for collective work | Family as discoverable presence unit (opt-in); shared declaration namespace; family business/band visibility |

---

## 11. Open Questions

### Protocol-Level

**1. Family DID scoping on the auth schema**

The current `auth.identities` type column supports `'human' | 'agent'`. Family scope requires either a new type (`'family'`) or a separate table (`auth.family_identities`). The separate table is architecturally cleaner — family DIDs have additional fields (guardian membership, dependent references, governance config) that don't belong on the core identity primitive. Ryan decides.

**2. Dependent references before actor DID registration**

A guardian wants to record a dependent who does not yet have their own actor DID — a young child. The dependent needs a named reference in the chain. Options:
- A placeholder in the family chain with a name/description field (encrypted) and a `pending_actor_did: null` that gets filled when they register
- A soft DID issued to the dependent by the guardian (extending the existing soft DID pattern to family-initiated registration)

The soft DID approach has more surface area but is more consistent with the existing identity model. The placeholder approach is simpler and avoids the governance question of who controls a dependent's soft DID.

**3. Minimum tier for family DID formation**

Should soft-tier DIDs be able to form or join a family scope? Soft DIDs have no keypair — they cannot sign governance operations. Preliminary-or-above is the minimum for meaningful family DID participation. A soft DID could be a dependent reference but not a guardian or signing member.

**4. Family DID keypair custody**

The family DID has its own keypair for signing collective actions (publishing .fair work as the family, signing discovery declarations). Who holds this private key? Options:
- The initiating guardian holds it (simplest, but creates single-point risk)
- Threshold signature: `m of n` guardians must co-sign any family keypair operation (more complex, more correct)
- The family keypair only signs non-sensitive operations; sensitive operations require individual guardian signatures

The threshold signature model is the correct answer architecturally but requires tooling that may not exist yet in `packages/auth`. This should be deferred to the implementation phase.

**5. Is family discovery truly opt-in, or should there be a family presence default?**

A family that never opts into discovery is invisible to the trust graph. This is probably correct — most families do not want to be a discoverable node. But a family that runs a shared project (a band, a small business, a newsletter) needs a frictionless path to discovery presence. The opt-in governance operation should be low-friction and reversible.

### Philosophical

**6. What is the smallest meaningful family?**

Is a person who lives alone and cares for an aging parent a family scope? Is a person who wants to establish a family DID in anticipation of future membership? The definition "care relationship with shared resources" handles both, but the protocol needs a clear answer about whether the initiating guardian must have at least one other member, or whether a solo guardian with no current additional members is a valid family DID.

The argument for permitting a solo guardian: family scope is about intent and care relationship, not headcount. The argument against: a family DID with one member is functionally identical to the actor scope with extra steps.

My position: permit the solo guardian family DID. The use case is real (a single parent with a dependent who hasn't yet registered their own actor DID), and forcing headcount minimums creates an artificial barrier that violates the sovereignty principle.

---

## 12. Decisions Required from Ryan

| # | Decision | Greg's position | Status |
|---|---|---|---|
| 1 | New `auth.identities` type `'family'` or separate `auth.family_identities` table? | Separate table — family DIDs carry governance fields that don't belong on the core identity primitive | Open |
| 2 | Dependent references: placeholder in family chain, or soft DID issued by guardian? | Placeholder is simpler and avoids soft DID governance questions; soft DID is more consistent with existing model — Ryan decides | Open |
| 3 | Minimum tier for family DID formation: preliminary+? | Yes — preliminary or above required to sign governance operations | Open |
| 4 | Family keypair custody: guardian-held vs threshold signature? | Threshold signature is correct; defer to implementation phase when tooling exists | Open |
| 5 | Family discovery: opt-in confirmed? | Yes — default private, opt-in for discovery presence | Open |
| 6 | Solo guardian family DID permitted? | Yes — real use case, consistent with sovereignty principle | Open |
| 7 | Does family scope appear in the pitch deck matrix as the fourth scope? | Yes — the matrix has a gap; filling it with this proposal closes the presentation story | Open |

**Resolution signals in the repository:**
- `auth.family_identities` table or `'family'` type in `auth.identities` in a migration
- Family DID formation endpoint in `apps/auth`
- RFC or discussion opened for Family DID scope
- Pitch deck matrix updated with family scope row

---

*The family is where the network begins. Every trust relationship, every care attestation, every shared resource — they start here, before community, before commerce. The architecture should reflect that.*

*— Greg, March 21, 2026*
