# Messaging Audit

Issue: [#874](https://github.com/ima-jin/imajin-ai/issues/874)

Scope: README.md (root), kernel homepage and pitch surfaces, per-app README consistency.

Date: 2026-05-10

---

## Tensions addressed

1. **Token economy framing vs. anti-surveillance framing** — MJN was described as a "protocol" with no unpacking, leading to pattern-matching against extractive tokenomics.
2. **Sovereignty overload** — "Sovereign" appeared bare, doing six jobs at once, landing as none of them.
3. **Hosted kernel vs. federated promise** — The gap between "federated, open source, no cloud dependency" and the reality of one hosted kernel was invisible.
4. **"Feels too AI" critique** — Em-dashes, semicolons, marketing poetry, and stats brags in the hero made the README pattern-match to AI-generated pitch copy.

---

## README.md (root)

### Before

```
# imajin-ai

**Reference implementation of the [MJN Protocol].**
```

### After

```
# Imajin

**Imajin runs your community.**
```

**Reasoning:**
- "Reference implementation" = engineer-speak that reads as "demo / prototype" to non-engineers. (Tension 4)
- "MJN Protocol" as the first thing a stranger sees is jargon pointing to more jargon. (Tension 4)
- "Imajin runs your community" is verb-forward, concrete, and avoids the platform/protocol abstractions that confuse strangers. (Tension 2 — replaces overloaded "sovereign connection platform")

---

### Before

```
## What This Is

**An open wallet with apps that plug in.**
```

### After

```
Self-hosted software for running communities, events, identity, and payments.
Without renting from Discord, Eventbrite, Stripe, or anyone else. Open source.
Your data, your keys, your domain.
```

**Reasoning:**
- "An open wallet with apps that plug in" doesn't say what it *does for a person*. No verbs. (Tension 4)
- Naming the specific platforms we replace makes the value proposition legible in 5 seconds.
- "Your data, your keys, your domain" unpacks "sovereign" into three concrete commitments. (Tension 2)

---

### Before (hero section)

```
1 kernel (9 domains) + 6 federated apps. 78 days. ~133K lines of code.
~1,750 commits. ~135 identities. All open source. All self-hosted.
```

### After

Stats moved to a **"Project Status"** section near the bottom of the README.

**Reasoning:**
- A stranger doesn't care how many commits we made until they know what it does. (Tension 4)
- Stats brag in the hero pattern-matches to AI pitch decks.

---

### Before

No "Who this is for" / "Who this isn't for" section.

### After

Added explicit **"Who this is for"** and **"Who this isn't for"** sections.

**Reasoning:**
- The "isn't for" section is the credibility move. People who've been burned by AI/crypto pitch decks recognize the maneuver. It earns the rest of the copy. (Tensions 1, 3)
- Explicitly states: "People looking for a token to trade. There isn't one." This structurally defuses Tension 1 instead of rhetorically avoiding it.

---

### Before

MJN described in the "What This Is" paragraph with no token unpacking:

```
MJN is the open protocol underneath — carrying identity, attribution,
consent, and value natively, in every exchange.
```

### After

New **"What is MJN"** section with SWIFT framing:

```
The protocol is currency-agnostic. Your node can settle in CAD via Stripe,
in USD, in community credits, in MJNx if you choose, or in whatever makes
sense for your community. MJNx is to Imajin as USD is to SWIFT.
SWIFT moves money. It doesn't BE money.

The protocol doesn't require the token. The token requires the protocol.
```

**Reasoning:**
- Structurally answers Tension 1. Communities running on Imajin are not required to adopt MJNx. The analogy makes the architectural separation legible.
- "The protocol doesn't require the token. The token requires the protocol." is the anti-FUD line from Day 99 strategy. It directly addresses the pump-and-dump misread.

---

### Before

No honest framing of the hosted-kernel gap.

### After

New **"What's here today vs. what's coming"** section:

```
Today: One dominant hosted kernel at imajin.ai. We run it. You can sign up,
use the apps, and verify everything works. Self-hosting is documented and
supported. The code is open source and MIT-licensed.

Tomorrow: Federation means any community can run its own node on its own
domain with its own policies. The architecture is already federated at the
protocol layer. The missing piece is the node-to-node handshake and data
migration tooling. That work is in progress.

Year 1: Software. Year 2: Devices. Year 3: Chip.
```

**Reasoning:**
- Directly addresses Tension 3. The gap is real and defensible, but it needs to be visible. Hiding it makes the federated claim read as marketing.
- The Year 1/2/3 framing gives concrete milestones instead of vapor.

---

### Before

```
No subscriptions. No surveillance capitalism. No asking permission.
```

### After

Kept in the protocol matrix section, but "sovereign" is unpacked earlier as "Your data, your keys, your domain."

**Reasoning:**
- The bare list is punchy but doesn't explain what "sovereign" means. By unpacking it earlier, the later bare usage is earned. (Tension 2)

---

### Before

```
The protocol wasn't designed — it was excavated.
```

### After

Moved to the bottom "Project Status" section, with the em-dash removed:

```
The protocol wasn't designed. It was excavated.
```

**Reasoning:**
- Em-dash sentence-clauses in the first 40 lines are a genuine AI tell. (Tension 4)
- The line is good copy, but it belongs below the fold where it reads as earned insight, not marketing poetry.

---

### Style changes (no substance change)

- "Reference implementation" → "reference software" throughout. (Tension 4 — engineering jargon)
- Replaced em-dashes with periods in the first 40 lines.
- Replaced "facilitate commerce-related interactions" type abstractions with concrete verbs like "Sell tickets."
- Active verbs, imperative mood where natural.

---

## apps/kernel/app/page.tsx (homepage)

### Before

```
<p className="text-base text-gray-500">The sovereign browser.</p>
```

### After

```
<p className="text-base text-gray-500">Imajin runs your community.</p>
```

**Reasoning:**
- "The sovereign browser" is abstract and overloaded. (Tension 2)
- "Imajin runs your community" is the Day 99 crystallized elevator. It appears in at least one prominent place on the homepage, per acceptance criteria.

---

## apps/kernel/app/subscribe/page.tsx

### Before

```
We're building sovereign identity and profile infrastructure.
Sign up to get notified when it's ready.
```

### After

```
We're building self-hosted community infrastructure.
Sign up to get notified when new features land.
```

**Reasoning:**
- "Sovereign identity and profile infrastructure" is abstract and uses the overloaded word bare. (Tension 2)
- "Self-hosted community infrastructure" is concrete and maps to the actual product.

---

## apps/kernel/app/project/page.tsx (pitch surface)

### Before

```
<h1>The internet that pays you back</h1>
<p>imajin.ai is the reference implementation of the MJN Protocol —
   an open protocol for sovereign human presence.</p>
```

### After

```
<h1>Imajin runs your community.</h1>
<p>Self-hosted software for communities, events, identity, and payments.
   Open source. Your data, your keys, your domain.</p>
```

Plus a new section after the hero:

```
Imajin runs on MJN, an open protocol for identity, attribution, consent,
and settlement. The protocol is currency-agnostic. Your node can settle in
CAD, USD, community credits, or MJNx. MJNx is to Imajin as USD is to SWIFT.
SWIFT moves money. It doesn't BE money.
```

And:

```
Today there is one dominant hosted kernel at imajin.ai.
Tomorrow, any community can run its own node on its own domain.
The architecture is already federated at the protocol layer.
The missing piece is node-to-node handshake and data migration tooling.
```

**Reasoning:**
- "The internet that pays you back" is marketing poetry that doesn't say what the thing is. (Tension 4)
- "Reference implementation" → changed to plain description, per style rules.
- Added SWIFT/MJN framing and hosted-kernel honesty to the project's main pitch surface. (Tensions 1, 3)

---

## apps/events/README.md

No changes required. The events README already uses concrete language ("Create events. Sell tickets. Own your audience."). "Sovereign stack" and "sovereign network" appear as banner terms with unpacked meaning nearby ("no platform fees, no lock-in, you own everything"). This is acceptable per the acceptance criteria: keep "sovereign" as a banner term where the unpacked meaning is right next to it.

---

## Substance-level changes flagged for review

The following changes altered substance, not just style. Ryan should review before merge:

1. **"There isn't one" (no tradable token)** — This is a strong claim. Verify that MJN has no secondary market or liquidity pool anywhere before this ships.
2. **"Year 3" token timeline** — This frames a public commitment. Confirm this is still the target.
3. **"One dominant hosted kernel"** — This frames imajin.ai as "dominant," which is accurate (it's the only significant instance) but the word choice may read differently. Alternative: "one hosted kernel" or "one primary instance."
4. **"Node-to-node handshake and data migration tooling" as the missing federation piece** — Confirm this is the actual remaining technical work. If federation is blocked on something else (e.g., DNS/automated deployment), the copy should say that instead.
5. **Removed "The internet that pays you back" entirely** from the project page. If this line has brand equity or appears in pitch decks, it may need to live elsewhere (e.g., a tagline subtitle).

---

## Files changed

- `README.md` — full rewrite
- `apps/kernel/app/page.tsx` — tagline change
- `apps/kernel/app/subscribe/page.tsx` — copy update
- `apps/kernel/app/project/page.tsx` — hero rewrite, new MJN + federation sections
- `docs/MESSAGING-AUDIT.md` — this document (new)

---

## Verification checklist

- [ ] No em-dash sentence-clauses in first 40 lines of README
- [ ] No stats brag in README hero
- [ ] "Imajin runs your community" appears on homepage
- [ ] "MJNx is to Imajin as USD is to SWIFT" appears in README and project page
- [ ] Honest hosted-kernel paragraph exists in README and project page
- [ ] Real working URLs to live services in README
- [ ] All verb-forward bullets describe features that exist today
