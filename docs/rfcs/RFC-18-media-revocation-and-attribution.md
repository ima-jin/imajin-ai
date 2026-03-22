# RFC-18: Media Revocation & Cross-Graph Attribution

**Author:** Jin + Ryan  
**Date:** March 22, 2026  
**Status:** Draft  
**Relates to:** RFC-01 (.fair attribution), P27 (Unified Identity Substrate), #418 (.fair portable attribution)

---

## Problem

When a user uploads an image to the media service, that asset may be referenced by multiple services: market listings, profile photos, event banners, chat messages, course materials. Currently:

1. **Deletion is destructive** — hard deletes the file + DB row, breaking all references (404 broken images)
2. **No dedup across users** — same file uploaded by different people creates separate copies with no shared provenance
3. **No revocation model** — a user cannot revoke an image and have that revocation propagate to all places it appears
4. **No attribution chain** — when the same content appears via multiple uploaders, there's no record of provenance

These problems compound under the unified identity substrate: if assets are chain-addressable and portable across nodes, revocation and attribution become protocol-level concerns, not just application bugs.

## Core Tension

**The right to revoke** vs. **the integrity of the attribution chain.**

- A creator should be able to say "I don't want this image on the network anymore" at any time
- But other people may have legitimately referenced, attributed, or built on that content
- And the attribution chain (who uploaded what, when, with what provenance) has historical value even if the content is removed

This is the same tension that exists in copyright, DMCA, right-to-be-forgotten. We're not solving it for the whole internet — but we need a clear model for Imajin.

## Design Questions

### 1. What does "revoke" mean?

Options:
- **Hard delete:** File removed from disk, DB row deleted, all references break
- **Soft delete + tombstone:** File removed from disk, DB row marked `revoked`, references get a tombstone ("this content was removed by the creator") instead of 404
- **Attribution withdrawal:** Creator removes their attribution from the .fair chain, but the content remains if other attributors exist
- **Full revocation:** Creator demands removal regardless of other attributors (nuclear option)

### 2. Cross-graph dedup: what happens when the same file has multiple uploaders?

Current: dedup is owner-scoped (same hash + same owner = return existing).

Proposed: dedup across the graph. Same hash from a different uploader joins the .fair attribution chain instead of creating a duplicate. But then:

- Who "owns" the canonical copy? First uploader? Or is ownership shared?
- If the first uploader revokes, does the file survive because others have attribution?
- If the file was independently created by two people (convergent content), neither is "copying" — both are creators
- If one uploader is reposting someone else's work, the attribution chain makes that visible

### 3. Reference tracking

Services that reference media assets (market, profile, events, chat, learn) need to:
- Register their reference when attaching an asset
- Be notified (or discover) when an asset is revoked
- Handle revocation gracefully (tombstone, placeholder, removal)

This implies either:
- **A reference table** in media: `asset_references(asset_id, service, entity_type, entity_id)`
- **Webhook/event system:** media emits a `asset.revoked` event, services subscribe
- **Lazy resolution:** services check asset status on render, handle 410 Gone

### 4. Revocation across federation

If an asset is chain-addressed (CID) and has been replicated to another node:
- Can the creator revoke it on other nodes?
- How does revocation propagate? Chain operation? Signed revocation message?
- What if the other node refuses to honor the revocation? (Sovereignty conflict)

### 5. .fair attribution chain mechanics

When dedup joins a new uploader to an existing asset:
- What role do they get? `contributor`? `re-uploader`? `reference`?
- Does the .fair manifest update in place, or is a new version created?
- Is there a concept of "primary creator" vs. "subsequent attributors"?
- How does this interact with content chains (DFOS content operations)?

## Proposed Model (Sketch)

### Revocation tiers

| Tier | Action | Effect | Reversible? |
|------|--------|--------|-------------|
| **Withdraw** | Remove your attribution | Your name off the chain, content stays if others have attribution | Yes (re-add) |
| **Soft revoke** | Request removal | Content stops serving (410 Gone), tombstone replaces references, .fair chain records revocation | Yes (un-revoke) |
| **Hard revoke** | Demand deletion | File deleted from disk, DB marked `hard_revoked`, cannot be re-uploaded by others | No |

### Reference lifecycle

1. **Attach:** Service registers reference → `POST /api/assets/{id}/references`
2. **Serve:** Asset serves normally → `GET /api/assets/{id}` returns content
3. **Revoke:** Creator revokes → asset status changes, references get notified/discover
4. **Tombstone:** References render a placeholder: "This content was removed by the creator"
5. **Cleanup:** Service removes the reference from its records (optional)

### Cross-graph dedup model

1. Upload → hash computed → check if hash exists network-wide
2. If exists: add uploader to .fair attribution chain, return existing asset URL
3. If new: create asset, initialize .fair chain with uploader as creator
4. Revocation by any single attributor = withdrawal (tier 1)
5. Revocation by ALL attributors = soft revoke (tier 2)
6. Hard revoke = only available to original creator (first uploader)

## Open Questions

1. Should cross-graph dedup be opt-in? (Some users may not want their upload linked to an existing asset)
2. How do we handle private assets that happen to have the same hash as a public one?
3. What's the minimum viable version? (Probably: soft delete + reference table, no cross-graph dedup yet)
4. Does this need a chain operation type in DFOS? (`content.revoked`?)
5. Legal implications: does revocation create DMCA-like obligations for federated nodes?

## Minimum Viable Implementation

For immediate needs (market images breaking on delete):

1. Add `status: 'revoked'` option to assets (alongside 'active')
2. Asset delivery returns 410 Gone with tombstone JSON for revoked assets
3. Add `asset_references` table for cross-service reference tracking
4. Delete endpoint checks references — if any exist, soft revoke instead of hard delete
5. Market/profile/events check asset status on render, show placeholder for revoked assets

Cross-graph dedup and federation revocation are Phase 2+.

---

*This RFC needs community input. The revocation model affects every service that touches media.*
