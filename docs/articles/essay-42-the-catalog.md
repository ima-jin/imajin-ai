---
title: "The Catalog"
subtitle: "How to give every piece of music its own identity"
description: "The pirates already indexed everything. The streaming platforms captured the catalog. The attribution layer was never built. Until now."
date: "2026-04-26"
author: "Ryan Veteze"
status: "DRAFT"
type: "essay"
---

## The Problem Nobody Fixed

Every piece of recorded music exists in at least three places: a streaming platform, a torrent index, and a metadata database. Spotify has 100 million tracks. MusicBrainz has metadata for 30+ million releases. The torrent ecosystem has content hashes for nearly every album ever pressed.

None of them belong to the people who made them.

Spotify owns the relationship between the listener and the catalog. MusicBrainz is a volunteer effort with no economic layer. The torrent index is anonymous by design. The artist who sat in the studio, the label that funded the session, the publisher who registered the composition, the engineer who mixed it at 3am — none of them have a canonical identity attached to the work that *they* control.

Labels invest real money. They advance recording costs, carry legal risk, handle distribution, fight sample disputes, manage rights across territories. Publishers register compositions, chase royalties across borders, deal with collection societies in 30 countries. This is real work. Real infrastructure. The music industry runs on it.

But the tools they use to track it are broken. ISRCs exist. UPCs exist. Spotify URIs exist. None of them are sovereign. All of them are identifiers issued by someone else, controlled by someone else, revocable by someone else. An ISRC doesn't know who played guitar on the track. A Spotify URI stops working when Spotify decides it does. And a label's master rights — the thing they invested €50,000 to produce — live in a contract PDF that no system on earth can read automatically.

Some countries do it better. Germany's GEMA and its Urheberrecht model give creators and rights holders stronger protections than almost anywhere else. The session pianist gets registered. The publisher gets their share. It works — inside Germany. But the moment that track crosses a border, it's back to spreadsheets, collection society delays, and manual reconciliation across territories that don't talk to each other.

The music industry built a $28 billion streaming economy on top of a catalog with no attribution layer. Not because nobody cared. Because the infrastructure to connect rights holders — all of them — to a verifiable, portable, machine-readable record of who's owed what was never built.

---

## What an Attribution Layer Looks Like

Every track gets a DID. Every album gets a DID. Every artist gets a DID. Cryptographic identity — Ed25519 keypair, self-certifying, portable, controlled by whoever holds the keys.

The DID for a track carries a .fair manifest:

```
Track: "Midnight Architecture"
DID: did:imajin:track-midnight-architecture
Creator: did:imajin:studio-collective

.fair manifest:
  Label:      @velvet_records   30%  (master rights, advance recoup)
  Publisher:  @nightshift_pub   15%  (composition, sync licensing)
  Writer:     @sarah_keys       25%  (lyrics, toplining)
  Producer:   @marcus_waves     15%  (production, arrangement)
  Vocalist:   @elena_voice      8%   (session performance)
  Mix:        @dave_console     5%   (mix engineering)
  Master:     @abbey_road       2%   (mastering)

Attestations:
  MusicBrainz: MB-release-abc123
  ISRC: USRC17607839
  GEMA: werk-nr-12345678
  Torrent: magnet:?xt=urn:btih:a3f2...
  Spotify: spotify:track:4iV5W9uY
```

Signed. On-chain. Append-only. The label's master rights, the publisher's composition share, the session vocalist's 8% — all of it encoded in the manifest, enforced everywhere the track generates revenue. Not because a platform decided to honor the contract. Because the contract is the identity.

The label that invested in the recording is on the manifest forever. The publisher who registered the composition is on the manifest forever. The guitarist who played the session — the one that collection societies lose track of — is on the manifest forever. Because the rights holders signed it together.

The torrent hash isn't piracy. It's a content attestation — proof the work exists, content-addressed, distributed. The DID doesn't host the music. It *identifies* it. The platforms are playback surfaces that reference the DID. The DID outlives the platform.

---

## The Data Already Exists

MusicBrainz: open, structured metadata for millions of releases. Artists, albums, tracks, credits, relationships, ISRCs. Community-maintained. Free.

Discogs: vinyl-focused, crowdsourced. Every pressing, every variant, every credit. 16 million releases.

Torrent indexes: content hashes for nearly every album ever recorded. The file is already in the swarm. The hash is the proof.

OpenLibrary, IMDb, Wikidata — same pattern for books, films, everything.

All of this is scaffold. Someone runs a script against MusicBrainz, creates a DID for every release, links the metadata, attaches the torrent hash as a content attestation. Millions of stubs. Creator is the maintainer. Artist claims when ready.

The work of indexing humanity's creative output has already been done — by volunteers, by pirates, by obsessive music nerds who tagged every track because they cared. We don't redo their work. We give it an identity layer.

---

## The Claim

An artist shows up. Finds their catalog already tagged — every album, every track, every credit pulled from MusicBrainz, linked to torrent hashes, referenced against Spotify and Apple Music IDs.

They claim it. One action. The DID transfers to their control. They inherit everything — every connection, every attestation, every piece of context the community built around their work.

A label shows up. Finds 200 releases already stubbed, metadata intact, cross-referenced across databases. Claims the catalog. One action per release — or bulk. The master rights that live in filing cabinets and contract PDFs are now cryptographically attached to the work itself.

Then the rights holders fill in what the databases don't know.

The .fair manifest on a MusicBrainz stub has credits — but it doesn't have splits. It doesn't know that the label advanced €50,000 for recording and gets 30% until recouped. It doesn't know the publisher registered the composition and handles sync licensing for 15%. It doesn't know the bass player got 8% of the publishing or that the sample clearance ate 15% of the revenue. The rights holders fill that in. Sign it together. The attribution chain that never existed on any platform — the one that actually says who gets paid what — is now on-chain.

The person who tagged the catalog — who did the work of connecting the commons to its creators — earns a commission on the scope fee. Declared at creation, negotiable on claim. The Muskoka model: curators earn when stubs generate value.

---

## The Piracy Inversion

The music industry spent 25 years fighting torrents. Suing teenagers. Shutting down Napster. Taking down Pirate Bay mirrors. Labels lost real money — not theoretical losses on an analyst's spreadsheet, but catalogs they'd invested in being distributed for free, with no attribution and no compensation for anyone in the chain.

The torrents won. The content is in the swarm. It's not coming back. That's the reality, and pretending otherwise hasn't worked.

But something unexpected came out of that fight. The metadata — the careful tagging, the complete discographies, the scene-level organization that torrent communities maintained with obsessive precision — is the most complete index of recorded music ever assembled. More complete than any label's catalog. More complete than Spotify's database. Built by people who cared about music enough to spend thousands of hours organizing it for free.

What if that index became evidence *for* rights holders instead of against them? A content-addressed hash tied to a DID that carries a .fair manifest — proof that a master exists, who owns it, who's owed what. The same infrastructure that the industry spent billions trying to destroy becomes the foundation of the attribution layer that was never built.

The pirates did the cataloging. The creators get the identity. The labels get enforceable rights. The curators who connect them earn a commission. And the industry that fought the pirates for a generation gets the one thing it never had: a sovereign, verifiable record of who made what and who's owed what.

Not because a platform decided to publish credits. Because the attribution is on-chain, signed by the rights holders, and nobody can edit it.

---

## The Economics

Claim your catalog. Free. No fee to claim what's yours — whether you're an artist, a label, or a publisher.

Someone buys merch through the artist's DID. Streams through a sovereign player. Buys a ticket to a show. Licenses a track for a sync. Any transaction against that DID flows through .fair:

```
Protocol:  1%    → MJN (network equity)
Node:      0.5%  → operator
Buyer:     0.25% → buyer credit
Scope:     0.25% → scope fee (split with curator)
```

The remaining 98% splits according to the .fair manifest — label, publisher, artist, session musicians, engineer. Automatically. Every time. Everywhere.

Compare how it works today: Spotify pays $0.004 per stream. The split between label and artist is whatever was negotiated — usually 80/20, sometimes better, sometimes worse. The session musicians get nothing unless they negotiated publishing, which most didn't. The songwriter gets a fraction of a fraction, processed through a collection society that takes 18 months to pay. And the label — the one that funded the recording, carried the legal risk, handled the distribution — is stuck chasing royalties across 30 territories through collection societies that each operate on their own timeline.

On Imajin, a fan pays $2 for a direct download. The .fair manifest executes instantly: the label gets its 30%, the publisher gets 15%, the artist gets their share, the session musicians get theirs. Settled in seconds. Not 18 months. Not "pending reconciliation." Done.

**For an indie artist with no label:** 5,000 fans × $2/month = $120,000/year. Split among collaborators per the manifest they signed.

**For a label with 200 releases:** every stream, every sync, every live play across 40 countries settles automatically per manifest. No chasing SACEM for French royalties. No reconciling JASRAC statements against GEMA registrations. The manifest is the contract, and the contract executes itself.

---

## The Open Catalog

This isn't a competing music service. It's infrastructure.

The DID is the canonical identity for the work. Spotify can reference it. Apple Music can reference it. YouTube can reference it. A sovereign player running on someone's Imajin node can reference it. The playback surface doesn't matter. The identity is the artist's.

The catalog is open. Anyone can browse it. Anyone can build on it. A developer builds a recommendation engine that reads .fair manifests and surfaces tracks where the session musicians overlap — "you liked this guitarist on three other albums, here's one you haven't heard." That recommendation carries provenance. It's not an algorithm guessing. It's attribution data, publicly verifiable, pointing you to work by people whose contributions are signed.

The torrent swarm is the CDN. The DID is the index. The .fair manifest is the attribution. The DFOS chain is the proof. The platforms are optional.

Build a player. Build a recommendation engine. Build a licensing marketplace. Build a fan club. Build whatever you want on top of a catalog where every track has an owner, every credit is signed, and every transaction splits fairly.

Free. Open. Sovereign.

*— Ryan VETEZE aka b0b*

---

**Origin:** This essay exists because of Skyland — Geordie and Debbie's event in South Africa. Being there in 2024 broke my brain. WeR1 was fingerprinting 60 tracks in a live DJ set in real time, but the money had nowhere to go. The attribution was solved. The identity wasn't. 84 days of building later, this is the answer.

**The music trilogy:**
- **[Essay 18 — How to Save the Music Industry](https://www.imajin.ai/articles/how-to-save-the-music-industry)** — Why music needs the relationship back
- **[Essay 21 — How to Save Media Streaming](https://www.imajin.ai/articles/how-to-save-media-streaming)** — How streaming broke the pipe
- **Essay 42** (this) — DID every track, .fair every credit, torrent as CDN

**The network:** [jin.imajin.ai](https://jin.imajin.ai)
**The why:** [Essay 18 — How to Save the Music Industry](https://www.imajin.ai/articles/how-to-save-the-music-industry)
**The protocol:** [protocol.dfos.com](https://protocol.dfos.com)
**The code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
