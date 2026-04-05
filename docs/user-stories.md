# User Stories

Concrete scenarios showing the system working for real people. No protocol jargon — just what happens and why it matters.

Each story maps to a matrix of **scopes** (who) × **primitives** (what). The same scenario can shift across scopes depending on persona context — a home cook saving a recipe is Actor×Attribution. A corporate chef publishing for a TV production is Org×Attribution + Org×Settlement.

### Scopes (Who)

| Scope | Description |
|-------|-------------|
| **Actor** | Individual person — their identity, actions, knowledge |
| **Family** | Household unit — shared resources, joint decisions, trust within |
| **Community** | Groups bound by interest, geography, or cause — events, mutual aid |
| **Org/Business** | Structured entities — employees, clients, revenue, compliance |

### Primitives (What)

| Primitive | Description |
|-----------|-------------|
| **Attestation** | Proving something happened — signed chain entries, bilateral verification |
| **Communication** | Messaging, conversations, broadcasts — information between parties |
| **Attribution** | Who made what — .fair manifests, credit chains, provenance |
| **Settlement** | Value exchanged — payments, fees, MJN/MJNx, Stripe, refunds |
| **Discovery** | Finding people, content, services — search, recommendations, agent queries |

### Matrix

|  | Attestation | Communication | Attribution | Settlement | Discovery |
|--|-------------|---------------|-------------|------------|-----------|
| **Actor** | | | | | |
| **Family** | | | | | |
| **Community** | | | | | |
| **Org/Business** | | | | | |

Stories fill cells. Good stories span multiple cells. Great stories show how a single action cascades across scopes.

---

## 1. The Dinner Party Recipe

**Who:** A home cook, a chef, and a group of friends  
**Services:** Learn, Media, Profile, .fair  
**Matrix:** Actor×Attribution, Actor×Discovery, Community×Communication, Community×Attribution

A chef publishes their beef rigatoni recipe on their Learn surface. It's signed with a .fair manifest — attributed, content-addressed, theirs.

A home cook browsing the platform saves the recipe to their collection. One tap. They don't think about attribution — they just want to make it later.

A few weeks later, they make it for a dinner party. Friends love it. Nobody remembers where the recipe came from.

Months later, one of the friends is planning their own dinner. They message the home cook: "what was that rigatoni?" The cook searches their saved collection, finds it, shares the reference.

The friend follows the reference. It resolves to the chef's Learn surface. The chef — who never met these people, never marketed to them, never ran an ad — sees that 14 people have saved this recipe and it's been referenced in 6 conversations.

**What happened:**
- The recipe traveled through social trust, not algorithms
- Nobody needed to understand .fair or attribution
- The chef got credit structurally — the save IS the attribution because it points to the signed original
- No screenshots, no reposts, no content stripping. The reference is the content.
- Everyone just saved a recipe and asked a friend about dinner.

---

## 2. (Template)

**Who:**  
**Services:**  

*(Story)*

**What happened:**

---

*Add stories as they emerge from conversations, pitches, and real usage. Keep them human — the protocol is invisible.*
