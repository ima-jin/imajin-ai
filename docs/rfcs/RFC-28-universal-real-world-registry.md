# RFC-28: Universal Real-World Registry — DIDs for Everything

**Author:** Ryan Veteze
**Date:** April 21, 2026
**Status:** Draft
**Related:** RFC-27 (MCC), #653 (stub identities), #581 (Mooi), #737 (branded sites)
**Pilot:** Muskoka (Bracebridge + Gravenhurst)

---

## Summary

Anyone can tie a DID to any real-world asset — a business, a building, a park, a trail, a monument, a government office, a work of art. The chain records who created the identity and when (signing provenance). The rightful owner can claim it at any time and inherit everything the community built.

This is DNS for the real world. Open, community-built, cryptographically provenant, and claimable.

## The Model

### Anyone Can Create

Any person with an Imajin identity can create a stub for any real-world thing:

- A café they love
- A park they visit
- A bridge they drive over
- An artist they follow
- A government office they use
- A historic building they want to document

The creator becomes the **maintainer**. They curate the profile — photos, descriptions, data, context. They're doing real work: a photographer's café profile looks different from an engineer's bridge profile. The creative quality IS the value.

### Signing Provenance

Every stub has provenance on the chain:

```
Created: 2026-04-21T14:30:00Z
Creator: did:imajin:sarah_photographer
Subject: "Muskoka Roastery" (business/cafe)
Location: 44.8833° N, 79.2441° W
Commission: 90/10 (90% to owner, 10% to creator)
Signature: [Ed25519 sig]
```

First-to-sign establishes provenance. The chain is the proof. You can't backdate it. You can't fake it.

### Owners Can Always Claim

The rightful owner can claim any stub at any time:

1. Owner verifies their identity (business registration, property deed, government authority)
2. Claim transfers control — owner becomes `owner` role, creator stays as `maintainer`
3. Owner inherits everything: reviews, check-ins, connections, photos, data, chain history
4. Owner can accept the commission split or renegotiate
5. Owner can remove the maintainer if they choose (but the chain records the creator's contribution forever)

### Commission Split

Creators declare a commission split at creation time. This is the incentive to curate well:

| Split | Meaning |
|-------|---------|
| 95/5 | "I built this for the community, I want almost nothing" |
| 90/10 | Standard — fair compensation for real curation work |
| 80/20 | "I'm doing heavy lifting — full menu, pro photos, SEO" |
| Custom | Negotiable on claim |

Commission applies to transactions that flow through the profile — ticket sales, bookings, tips, purchases. If no transactions happen, no commission. The incentive is aligned: curators earn only when the profile generates value.

### Anti-Squatting

A stub with no activity (no photos, no reviews, no check-ins, no data) is squatting. Protection:

- **Rightful owner can always claim** — squatter loses maintainer role
- **Petition to remove** — anyone can flag an empty/inactive stub
- **Activity threshold** — stubs with zero activity after 90 days are auto-flagged
- **Reputation cost** — serial squatters accumulate flags on their own chain. Their trust score drops.
- **The chain is the evidence** — you can see exactly when the stub was created, what was added, and whether the maintainer did real work

The community self-polices. The chain provides the evidence. No moderation team needed.

## Real-World Asset Types

### Scope: Business
Cafés, restaurants, shops, salons, studios, venues, farms, services.

### Scope: Community
Parks, trails, beaches, community centres, libraries, public spaces, neighbourhoods.

### Scope: Infrastructure
Bridges, roads, buildings, utilities, public transit stops, cell towers.

### Scope: Government
Municipal offices, provincial services, federal buildings, courts, post offices.

### Scope: Cultural
Monuments, murals, historic sites, galleries, theatres, landmarks.

### Scope: Natural
Lakes, rivers, waterfalls, lookout points, geological formations.

### Scope: Creative
Artists, musicians, writers, filmmakers — the people, not just the places.

Each type has appropriate subtypes and metadata fields. A café has menu items and hours. A bridge has load capacity and inspection dates. A lake has water quality and depth. The schema adapts.

## The Creative Class as Curators

This is not a data entry job. This is creative work:

- **Photographers** shooting seasonal storefront photos
- **Writers** crafting the perfect bio for a local institution
- **Designers** building visual identity for unclaimed businesses
- **Historians** documenting the story behind a 150-year-old building
- **Foodies** cataloguing every menu item with tasting notes and photos
- **Superfans** loading an artist's complete history — discography, press, tour dates

The quality of curation is visible. The chain shows who contributed what. A beautifully curated profile attracts more check-ins, more reviews, more connections — which means more transactions, which means more commission for the curator.

**Decentralized A&R.** The person who discovers and develops a presence on the network — whether it's a musician, a café, or a waterfall — earns attribution forever.

## The Muskoka Pilot

### Summer Street Team Program

Hire local youth (high school / college students) to walk Bracebridge and Gravenhurst creating stubs for every real-world thing worth documenting.

**The job:**
- Walk Main Street with a phone
- Create business stubs (name, category, location, photos, hours)
- Document public spaces, landmarks, trails, venues
- Leave a card explaining how the owner can claim
- Report bugs, test the mobile experience

**The incentive:**
- $15–18/hr base pay
- Commission on every stub that generates transactions after claim
- First come, first served — the best stubs earn the most
- Portfolio of creative work (photography, writing, documentation)
- Real tech experience on a resume

**The economics:**
- 10 students × 20 hrs/week × 12 weeks × $17/hr = ~$40K
- Target: 500+ stubs across Muskoka in one summer
- Cost per stub: ~$80 (includes salary + overhead)
- Each claimed stub is a customer that costs $0 to convert — they came to you

**What Muskoka gets:**
- Youth employment in tech (not seasonal retail)
- Complete digital directory of local businesses, landmarks, and public spaces
- Community-owned data (not Google, not Yelp)
- Infrastructure for tourism (every visitor taps a card, sees every curated business)
- The kids are creatives — the stubs look good

**What Imajin gets:**
- 500+ real-world assets with DIDs
- Battle-tested mobile UX from real field conditions
- Customer acquisition funnel (stubs → claims → active accounts)
- The pilot that proves the model before scaling to other regions

### The Conversion Path

```
Summer 2026:
  Students create 500 stubs
    ↓
  Visitors check in, leave reviews (NFC cards at visitor centre)
    ↓
  Owners Google themselves, find their Imajin profile
    ↓
  Owners claim (free) → respond to reviews
    ↓
  Owners want to transact → upgrade to active (metered)
    ↓
Fall 2026:
  200+ claimed businesses on the network
  Muskoka has a sovereign business directory
  Students earned commissions on active profiles
  Model proven → expand to other regions
```

## Scaling Beyond Muskoka

The pilot proves the model. Then:

- **Other municipalities** fund their own street team programs
- **Tourism boards** sponsor regional stub creation
- **BIAs (Business Improvement Areas)** claim entire districts
- **Provincial / federal** programs fund the infrastructure layer
- **SCIP** ($890M) — sovereign digital infrastructure for Canadian communities

Each region builds its own node. Nodes federate. The universal registry grows organically. No central authority decides what's in the directory — the community builds it, the owners claim it, the chain proves everything.

## Relation to Other RFCs

- **RFC-27 (MCC):** Agents can curate stubs autonomously. An AI agent with a DID walks Google Street View and creates stubs for every business — maintainer is the agent, commission goes to the agent's operator. Chain records every action.
- **RFC-19 (Kernel/Userspace):** Stubs are standard identities with `scope: business/community/infrastructure` and `claimed_by: null`. The kernel handles it.
- **#737 (Branded Sites):** A claimed stub can become a branded site. The curator's work becomes the starting template.
- **#749 (Campaign Events):** Community fundraising for local projects — "Save the historic mill" with a DID, a chain, and a funding goal.

## Implementation

The stub system already exists (#653). What's new:

1. **Commission split field** on stub creation (stored in .fair config)
2. **Expanded scope types** — infrastructure, cultural, natural, government (beyond business/community)
3. **Claim flow with commission negotiation** — owner accepts or counters the split
4. **Anti-squatting** — activity threshold, petition mechanism, reputation cost
5. **Street team tooling** — mobile-optimized stub creation, batch mode, offline support
6. **NFC card → stub check-in flow** — visitor taps card at a location, stub gets a check-in

Most of this is configuration and UI on existing infrastructure. The hard part isn't the code — it's the pilot.

---

*"DNS for the real world. Community-built, cryptographically provenant, and claimable."*

*"The creative class building for the creative class."*

*"You don't need to convince 500 businesses to sign up. You need 10 kids with phones."*
