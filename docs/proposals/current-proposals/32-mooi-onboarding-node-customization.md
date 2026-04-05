## 32. Mooi Onboarding — Node Customization, Progressive Disclosure, and the First CulturalDID

**Author:** Greg Mulholland
**Date:** April 3, 2026
**Priority:** HIGH — first real CulturalDID onboarding; validates the app studio thesis
**Matrix cells:** Community scope x All primitives
**Related issues:** #254 (Application Plugin Architecture), #474 (Founding Supporter)
**Related RFCs:** RFC-07 (Cultural DID), RFC-09 (Plugin Architecture), RFC-19 (Kernel/Userspace)
**Related concerns:** C04 (Org DID vetting), C13 (covenant), C16 (Family DID primitive)
**Connects to:** P10 (Org DID Vetting), P14 (Governance Equity), P28 (Launch Readiness)

---

### 1. Context — Mooi and the Problem It Reveals

**Mooi** is an event space in Toronto with capacity for 150–500 people. Borzoo, the operator, met with Greg in late March 2026. Borzoo wants a membership platform and event hosting/ticket sales system. He is willing to try Imajin — but only if it's simple, focused, and doesn't require him to babysit the process.

Borzoo's requirements are minimal and clear:
- Membership management for his community
- Event creation and ticket sales
- A forum-style space for event proposals and discussion
- A way to crowd-fund events before committing to booking

What Borzoo does **not** want:
- A platform that looks like another social media app
- Feature overwhelm (Discord syndrome — too many things happening at once)
- To become an expert in Imajin's architecture before he can use it
- Handholding through a complex setup process

This is the exact use case the app studio model was designed for — and it reveals a gap in the current implementation. Imajin today presents every feature to every user. There is no mechanism for a node operator to scope the experience down to what their community actually needs. Mooi doesn't need a marketplace, a course platform, or a curated links page. Presenting those features to Mooi members would actively harm adoption.

**The CulturalDID plan:** Borzoo will be the founder of the Mooi CulturalDID. Greg and Ryan will join as founding members to ensure smooth implementation and to bridge the trust graph between Mooi and the wider Imajin network. Per RFC-07, the CulturalDID requires 5–7 founding Person DIDs — additional founding members will be drawn from Borzoo's existing community during onboarding.

---

### 2. The Principle — Progressive Disclosure, Not Feature Flags

The Imajin pitch is sovereignty. The node operator controls the infrastructure. The user controls their identity. But today, neither the operator nor the user can control what they *see*.

This proposal introduces a principle that should govern every CulturalDID onboarding going forward:

**People adopt tools by using them for one thing they need — not by being shown everything the tool can do.**

A person who signs up for Mooi needs to land on Mooi, not on Imajin. They need to see events, discussion, and membership — not a marketplace, a course platform, and a tip jar. They will discover those features naturally over time, as their participation deepens and their trust graph expands. The architecture already supports this (RFC-19's kernel/userspace model, RFC-09's plugin architecture, the profile `feature_toggles` JSONB column). What's missing is the operator-facing and user-facing control surface.

This is not a feature toggle in the engineering sense. It's a design philosophy: **the system should feel like it was built for the community that's using it, not like the community is borrowing someone else's system.**

This resonates directly with Imajin's core principles:
- **Sovereign identity** means the node looks like the node, not like Imajin
- **Trust-gated access** means features appear as relationships deepen
- **Node operator autonomy** means operators control the experience, not the protocol
- **User control** means individuals choose what they engage with

---

### 3. Node Management Interface — The Router Page

Every wifi router has an admin page. It's simple, it's local, it's not trying to sell you anything. You go in, you configure what you need, you leave. Node operators need the same thing.

#### 3.1 What It Is

A node administration page at `admin.{node}.imajin.ai` (or `{node}.imajin.ai/admin`) that lets operators configure their node's behavior without touching code. The mental model is a router admin page — functional, no-frills, organized by concern.

#### 3.2 Configuration Scopes

**Identity & Membership**
- CulturalDID display name, description, visual identity (logo, colors, banner)
- Membership tiers visible to this node's members
- Onboarding flow: what happens when someone joins through this node
- Whether members see the broader Imajin network or only this node's community

**Enabled Services**
- Toggle which userspace apps are active on this node
- Example for Mooi: Events ON, Chat ON, Forum/Discussion ON, Marketplace OFF, Learn OFF, Links OFF, Coffee OFF, Dykil OFF
- Core services (auth, pay, profile, connections) are always active — they are the kernel
- Each toggle controls: whether the app appears in the navigation, whether the app's routes are accessible, and whether the app emits attestations on this node

**UI Presentation**
- Landing page selection: node community page (default for CulturalDIDs) vs. member's personal page
- Navigation layout: which items appear in the main nav, which are in a secondary menu
- Theme/skin selection (within the design system — colors, typography, density)
- Forum mode: whether the community's primary view is a discussion board rather than a feed

**Settlement & Fees**
- Node operator fee rate (0.25%–2%, per fee model v2)
- User credit rate (0.25%–2%)
- Payment methods accepted (Stripe, Solana, both)
- Escrow configuration (for crowd-funded events — see Section 6)

#### 3.3 Implementation Path

The infrastructure is mostly in place:
- `packages/config/src/services.ts` already defines service visibility by tier (`public`, `authenticated`, `creator`, `internal`)
- `apps/profile/src/db/schema.ts` already has a `feature_toggles` JSONB column
- RFC-19's app registration model already supports scoped delegated sessions
- RFC-09's plugin architecture already describes enable/disable semantics

What's needed:
1. A **node configuration table** (or CulturalDID config) that stores the operator's service toggle preferences
2. A **node admin UI** — a simple Next.js page behind auth, reading/writing to that config
3. **Launcher filtering** — `packages/ui/src/nav-bar.tsx` and the app launcher already filter by tier; extend to filter by node config
4. **Landing page routing** — per-node routing that respects the operator's landing page choice

---

### 4. Client-Focused Landing Pages — You Land Where You Belong

#### 4.1 The Problem

Today, every user lands on the Imajin homepage. This works for people who signed up for Imajin. It doesn't work for people who signed up for Mooi.

A Mooi member who knows nothing about Imajin should land on **Mooi's page** — the community forum, upcoming events, membership info. They should not land on a generic platform homepage with 15 services listed. They should not even know what Imajin is until they naturally encounter it through the trust graph.

#### 4.2 The Landing Page Hierarchy

**First visit (unauthenticated):**
- `mooi.imajin.ai` → Mooi's public landing page: what Mooi is, upcoming events, how to join
- Not the Imajin homepage. Not a login wall. A community page.

**Authenticated, single-node member:**
- Login → lands on Mooi's community page (forum/events view)
- The nav shows only what Mooi has enabled
- Imajin branding is minimal — "Powered by Imajin" in the footer, not the header

**Authenticated, multi-node member:**
- Login → lands on their personal page (or their most recent node, configurable)
- Node switcher in nav lets them move between communities
- Each community renders its own theme and enabled services

#### 4.3 Why This Matters for Adoption

People don't adopt platforms. They adopt communities. The community is the entry point. The platform is the infrastructure. If the infrastructure is invisible and the community is visible, adoption is frictionless. If the infrastructure demands attention before the community can function, adoption fails.

Every CulturalDID that onboards should be able to present itself as *itself* — not as a tenant on someone else's platform. The subdomain is theirs. The look is theirs. The feature set is theirs. The identity infrastructure is shared, but the experience is sovereign.

---

### 5. UI Simplification — Less Is More

The current nav structure has accumulated features organically. For a focused deployment like Mooi, it needs to be leaner. These changes benefit all users, not just Mooi.

#### 5.1 Eliminate Dropdown Duplication

**Current state** (from `packages/ui/src/nav-bar.tsx`):
- Messages appears in **both** the main nav quick access AND the user dropdown
- Connections appears in **both** the main nav quick access AND the user dropdown

**Proposed:** Remove Messages and Connections from the user dropdown. They already have prominent placement in the main nav. The dropdown should be for settings and account actions, not for navigating to features that are already one click away.

#### 5.2 Consolidate Profile Actions

**Current:** "View Profile" and "Edit Profile" are separate dropdown items.

**Proposed:** Single "Profile" item in the dropdown that goes to the profile page. The profile page itself has an "Edit" button. This is the standard pattern (GitHub, Twitter, every social platform). One item instead of two.

#### 5.3 Consolidate Help/Support

**Current:** "Security" and "Report a Bug" are separate dropdown items.

**Proposed:** Single "Help & Settings" item that opens a settings/support page with sections for Security, Notifications, and Bug Reporting. Three dropdown items become one.

#### 5.4 Move Connections to Messages

**Current:** Connections has its own nav icon and dropdown entry.

**Proposed:** Connections becomes a tab or sidebar on the Messages page. People you're connected to are the people you message. The relationship is structural — a connection is a messaging context. One nav item instead of two.

#### 5.5 Move Learn to Community Page

**Current:** Learn appears in the main app launcher for all users.

**Proposed:** Learn appears on the Imajin community page (or a node's page if the node has learning enabled). It is not a top-level navigation item for nodes that don't use it. For Mooi, it's invisible. For an education-focused CulturalDID, it's the primary feature.

#### 5.6 User Feature Preferences

**Current:** Users see every enabled feature whether they want to or not.

**Proposed:** Users can toggle feature visibility from their profile settings. The profile `feature_toggles` JSONB column already exists for this. The UI just needs a settings panel where users check/uncheck which apps appear in *their* navigation.

This is two levels of control:
1. **Node operator** decides what's *available* on the node
2. **User** decides what's *visible* in their personal nav (within the operator's scope)

The operator sets the ceiling. The user sets their own floor.

#### 5.7 Summary of Nav Changes

| Item | Current Location | Proposed |
|------|-----------------|----------|
| View Profile | Dropdown | Remove (merge into "Profile") |
| Edit Profile | Dropdown | Remove (edit button on profile page) |
| Profile | — | Dropdown (single item, links to profile page) |
| Messages | Nav + Dropdown | Nav only |
| Connections | Nav + Dropdown | Tab on Messages page |
| Security | Dropdown | Move to Help & Settings page |
| Notifications | Dropdown (settings link) | Move to Help & Settings page |
| Report a Bug | Dropdown | Move to Help & Settings page |
| Help & Settings | — | New dropdown item (replaces Security + Bug) |
| Learn | App launcher (all users) | Community/node page (if enabled) |
| Logout | Dropdown | Dropdown (unchanged) |

**Net effect:** Dropdown shrinks from ~8 items to ~4: Profile, Help & Settings, Balance/Wallet, Logout. The nav is clean. The cognitive load is minimal.

---

### 6. Crowd-Funded Events — Mooi's Signature Feature

Borzoo wants a mechanism that doesn't exist on any event platform today: community-driven event funding where the audience decides whether an event happens before anyone commits money.

#### 6.1 The Flow

**Stage 1 — Proposal (Forum Thread)**
A member (or the operator) posts an event idea to the community forum:
- Description: "500-person warehouse party with international DJ"
- Estimated cost: $15,000
- Ticket price: $50
- Interest threshold: 300 expressions of interest

The post functions as a forum thread. Members discuss, suggest modifications, express enthusiasm or concerns. This is community governance in action — the event is shaped by the people who will attend it.

**Stage 2 — Interest Polling**
Members express interest with a single action (not a payment). This is a lightweight commitment — "I would attend this if it happens." The interest count is public. When the threshold is reached (300 in this example), the proposal advances.

Attestation emitted: `event.interest` — subject DID expressed interest in proposed event. This is a trust signal: demonstrated engagement with community governance.

**Stage 3 — Funding Commitment**
The 300 interested members are asked to commit. The commitment is a real payment (held in escrow). The event needs 200/300 to commit for it to proceed to booking.

Attestation emitted: `event.funded` — subject DID committed funds to a proposed event.

**Stage 4a — Threshold Met: Booking**
If 200+ commit, the event moves to booking/planning. Funds remain in escrow until the event occurs. The organizer (Borzoo) can draw against the escrow for venue deposits, artist booking, etc., with community-visible accounting via `.fair` attribution.

**Stage 4b — Threshold Not Met: Return or Pool**
If fewer than 200 commit, each contributor is offered a choice:
1. **Full refund** — money returns via the refund system (#561, already built)
2. **Community resource pool** — funds go into a CulturalDID treasury where members vote on proposed uses

The resource pool is the community's collective investment in future events. It's governed by the CulturalDID's trust-weighted governance (RFC-07). This is *exactly* what CulturalDID governance was designed for — collective economic decisions by demonstrated participants.

#### 6.2 Escrow Requirements

This feature depends on escrow capability that does not yet exist in `apps/pay`:

1. **Escrow account creation** — a Stripe-backed holding account per event proposal
2. **Conditional release** — funds released when threshold is met and operator approves
3. **Automatic refund** — if threshold isn't met within a time window, funds auto-return
4. **Partial draw** — operator can draw against escrow for deposits (with `.fair` attribution tracking)
5. **Community pool** — CulturalDID-scoped treasury for redirected funds

The refund infrastructure (#561) provides the return path. What's needed is the hold-and-release mechanism — Stripe's Payment Intents with manual capture, or Stripe Connect with delayed transfers.

#### 6.3 Attestation Chain

The crowd-funding flow generates a rich attestation trail:

| Stage | Attestation | Trust Signal |
|-------|------------|-------------|
| Proposal created | `event.proposed` | Community governance participation |
| Interest expressed | `event.interest` | Engagement signal |
| Funding committed | `event.funded` | Economic commitment |
| Threshold met | `event.confirmed` | Collective decision |
| Event attended | `event.attendance` | Physical presence (existing) |
| Funds pooled | `treasury.contributed` | Community investment |

Every step is a trust signal. A member who proposes events, expresses interest, funds commitments, and attends — that standing is *computed* from their attestation history, not assigned by an admin.

---

### 7. The Mooi Node — What It Looks Like

Putting it all together, here is what the Mooi deployment looks like:

#### 7.1 Public View (`mooi.imajin.ai`)
- Mooi branding, not Imajin branding
- Upcoming events (public)
- Community description
- "Join" button → registration flow (creates DID, joins CulturalDID)
- "Powered by Imajin" in the footer

#### 7.2 Member View (authenticated)
- **Landing page:** Community forum — discussion threads, event proposals, announcements
- **Navigation:** Events, Messages, Forum. That's it.
- **User dropdown:** Profile, Help & Settings, Logout
- **No marketplace, no learn, no links, no coffee, no dykil**
- **Theme:** Forum/BBS density — thread lists, not cards. Conversation-first, not content-first.

#### 7.3 Admin View (`mooi.imajin.ai/admin`)
- Service toggles: Events ON, Chat ON, Forum ON, everything else OFF
- Landing page: Community forum
- Theme: BBS/forum
- Membership: CulturalDID with Borzoo as founder
- Escrow: Enabled for crowd-funded events
- Fee rate: Node operator rate (Borzoo sets this)

#### 7.4 Member Discovery
As Mooi members interact — attend events, fund proposals, message each other — they accumulate attestations. Their trust graph grows. Eventually they encounter connections from outside Mooi. They see that their DID works on other nodes. They discover the marketplace, or courses, or another CulturalDID. The platform reveals itself through use, not through onboarding.

This is progressive disclosure through the trust graph. The architecture doesn't change. The user's *awareness* of the architecture changes — at their pace, through their relationships, for their reasons.

---

### 8. Implementation Priority

| Priority | Item | Effort | Blocked By |
|----------|------|--------|-----------|
| **P0 — Mooi launch** | CulturalDID formation (Borzoo + 4-6 founding members) | Low | RFC-07 formation threshold (5-7 founders needed) |
| **P0 — Mooi launch** | Node service toggles (admin config → nav filtering) | Medium | Node config table + admin UI |
| **P1 — Mooi launch** | Client-focused landing page routing | Medium | Per-node subdomain routing |
| **P1 — Mooi launch** | Nav simplification (Section 5 changes) | Low | UI changes only |
| **P1 — Mooi launch** | User feature preferences (toggle visibility) | Low | Profile settings UI for existing `feature_toggles` |
| **P2 — Post-launch** | Forum/discussion view (BBS-style thread list) | Medium | New UI component or chat adaptation |
| **P2 — Post-launch** | Event crowd-funding flow (Stages 1-4) | High | Escrow in pay service |
| **P3 — Post-launch** | Community resource pool / treasury | High | CulturalDID governance integration |
| **P3 — Post-launch** | Theme/skin system | Medium | Design system extension |

### 9. Open Questions for Ryan

| # | Question | Why It Matters |
|---|----------|---------------|
| 1 | Can we form a CulturalDID with fewer than 5 founding members for Mooi's initial launch, then add members to reach the RFC-07 threshold? | Borzoo + Greg + Ryan = 3. We need 2-4 more from Borzoo's community. If formation requires the full 5-7 simultaneously, we need to recruit before launching. |
| 2 | Is the node config table best implemented as a CulturalDID-scoped config, or as a separate `node_config` schema? | Determines whether node customization is tied to CulturalDID identity or to the infrastructure layer. |
| 3 | Can the existing `feature_toggles` JSONB on profiles be extended to serve both user preferences and node-level defaults? | Avoids a second toggle system. Node config sets defaults; user config overrides within bounds. |
| 4 | Is Stripe Payment Intents with manual capture sufficient for the escrow model, or do we need Stripe Connect with separate accounts? | Determines the complexity of the escrow implementation. |
| 5 | Should the forum/discussion view be a new service, or an adaptation of chat with thread semantics? | Chat already has the messaging substrate. Forum threads could be chat rooms with different UI density. |
| 6 | What is the timeline for Mooi's first event? | Determines how aggressively we need to build the crowd-funding flow vs. launching with standard ticketing first. |
| 7 | Does the nav simplification (Section 5) align with your UX direction, or is the current duplication intentional for discoverability? | Want to confirm before making UI changes that affect all users. |

### 10. Why This Matters Beyond Mooi

Mooi is not a special case. It's the **template**.

Every CulturalDID that onboards will have the same pattern: a specific community with specific needs, a node operator who wants control over the experience, and members who should not need to understand the full platform to use the part that matters to them.

The festival-in-a-box, the restaurant-in-a-box, the ag-in-a-box — these are all the same architectural pattern: a scoped deployment of the Imajin kernel with a focused set of userspace apps, a community-specific landing page, and progressive disclosure of the broader network through use.

If we get Mooi right — simple onboarding, focused UI, node operator autonomy, community-driven events — it becomes the reference implementation for every CulturalDID onboarding that follows. The business plan's "5 vertical leads, each building industry-specific platforms" starts here. Mooi is vertical lead #1's proof of concept.

The system is safe. It's built for them. They don't need to know how it works to trust that it does.

---
