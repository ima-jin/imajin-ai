# Bounty: imajin Syndication Service

**Labels:** `bounty` `good-first-contribution` `infrastructure` `attribution`  
**Repo:** `ima-jin/imajin-cli` (or relevant service repo)

---

## Overview

Build a syndication adapter that pushes content from a sovereign imajin node to legacy publishing platforms. The canonical source lives on imajin infrastructure. Platforms receive your content — they don't own it.

This is the bridge between sovereign infrastructure and the legacy web while it still exists.

## Why This Matters

Every platform you publish on today owns the canonical version of your work. Your Substack audience, your LinkedIn network, your Medium followers — all of that is held hostage by platforms that can change their terms, kill their APIs, or simply disappear.

This service inverts that. Your node is the source of truth. Syndication is a push event. The attribution chain — who wrote it, when, from where — travels with the content everywhere the platform allows it to land.

The .fair attribution record exists on the imajin side regardless of what any platform does downstream.

## Attribution Mechanic

**This is the important part.**

Every adapter you write gets pinned to your GitHub account in the imajin attribution chain. Your contribution is a permanent record in the infrastructure itself — not in a CONTRIBUTORS file, not in a readme, but in the .fair chain that every syndicated piece of content routes through.

You wrote the LinkedIn adapter. Every piece of content that syndicates to LinkedIn carries that fact. The chain speaks for itself.

---

## Scope

### Tier 1 — Core Adapters

Build a standardized adapter interface and implement the first platform targets:

- **LinkedIn** — OAuth 2.0, Share API and Community Management API. Long-form articles + standard posts.
- **Substack** — Email ingestion endpoint (no public API currently). Format preservation, canonical URL in footer.
- **Medium** — Slot reserved. API deprecated 2023, monitor for reopening. Ghost/RSS bridge as interim option.

Each adapter must:
- Accept a normalized imajin content object (title, body, canonical URL, author DID, .fair attribution metadata)
- Handle auth credential storage tied to the user's imajin profile (not a central store)
- Return a syndication receipt (platform post ID, URL, timestamp) written back to the node
- Fail gracefully and log — never silently drop content

### Tier 2 — Attribution Header Injection

Where platforms support it, embed attribution metadata:

- Canonical URL linking back to the sovereign source
- Author DID reference
- .fair chain hash (compact, verifiable)
- "Originally published at imajin.ai" footer with structured data

LinkedIn supports custom link previews. Substack email footers are fully controllable. Use what the platform gives you.

### Tier 3 — Return Signal Analytics

Track whether syndicated content converts back to the sovereign source:

- Referral tracking from syndicated posts back to the canonical imajin URL
- Per-platform conversion rates (which platforms return value vs. just consume content)
- Aggregate dashboard: publish once, see where it lands and what comes back

This data is worth publishing. The first real map of which legacy platforms are actually creator-aligned.

---

## Technical Notes

- Service should be an imajin CLI plugin or standalone microservice deployable alongside an imajin node
- Adapter interface should be typed and documented — other contributors can add new platform adapters without touching core logic
- Credentials stored locally, tied to the user's sovereign profile — no centralized credential store
- TypeScript, consistent with the imajin stack (Next.js / Vercel / Drizzle / Neon Postgres)

## Deliverables

- [ ] Adapter interface specification (TypeScript types + README)
- [ ] LinkedIn adapter (Tier 1)
- [ ] Substack adapter (Tier 1)
- [ ] Attribution footer injection (Tier 2)
- [ ] Basic syndication receipt logging
- [ ] Tier 3 analytics (stretch goal, separate PR welcome)

## Compensation

TBD — discuss in thread. Attribution in the .fair chain is non-negotiable and permanent regardless of other compensation.

---

## Context

This bounty emerged from the essay series *The Internet That Pays You Back* — specifically Essay 4 and Essay 10 (The Bridge). The syndication service is the practical instantiation of the bridge concept: sovereign source, legacy surfaces, attribution intact.

The meta-point: the first working demonstration of .fair attribution in production is the tool that builds .fair attribution into everything else. Your name is in the chain of the thing that creates chains.

---

*Questions? Comment below or reach out via imajin.ai*
