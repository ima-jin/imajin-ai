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

None of them belong to the artist.

Spotify owns the relationship between the listener and the catalog. The label owns the master. MusicBrainz is a volunteer effort with no economic layer. The torrent index is anonymous by design. The person who made the music — who sat in the studio, who wrote the lyrics, who played the session — has no canonical identity attached to their work that they control.

ISRCs exist. UPCs exist. Spotify URIs exist. None of them are sovereign. All of them are identifiers issued by someone else, controlled by someone else, revocable by someone else. An ISRC doesn't know who played guitar on the track. A Spotify URI stops working when Spotify decides it does.

The music industry built a $28 billion streaming economy on top of a catalog with no attribution layer.

---

## What an Attribution Layer Looks Like

Every track gets a DID. Every album gets a DID. Every artist gets a DID. Cryptographic identity — Ed25519 keypair, self-certifying, portable, controlled by whoever holds the keys.

The DID for a track carries a .fair manifest:

```
Track: "Midnight Architecture"
DID: did:imajin:track-midnight-architecture
Creator: did:imajin:studio-collective

.fair manifest:
  Writer:     @sarah_keys      40%
  Producer:   @marcus_waves    25%
  Vocalist:   @elena_voice     20%
  Mix:        @dave_console    10%
  Master:     @abbey_road      5%

Attestations:
  MusicBrainz: MB-release-abc123
  ISRC: USRC17607839
  Torrent: magnet:?xt=urn:btih:a3f2...
  Spotify: spotify:track:4iV5W9uY
```

Signed. On-chain. Append-only. Nobody edits it after the fact. The guitarist who played the session is on the manifest forever. Not because the label decided to credit them. Because the artist signed it.

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

Then they fill in what the databases don't know.

The .fair manifest on a MusicBrainz stub has credits — but it doesn't have splits. It doesn't know that the bass player got 8% of the publishing or that the sample clearance ate 15% of the revenue. The artist fills that in. Signs it. The attribution chain that never existed on any platform — the one that actually says who gets paid what — is now on-chain.

The person who tagged the catalog — who did the work of connecting the commons to its creators — earns a commission on the scope fee. Declared at creation, negotiable on claim. The Muskoka model: curators earn when stubs generate value.

---

## The Piracy Inversion

The music industry spent 25 years fighting torrents. Suing teenagers. Shutting down Napster. Taking down Pirate Bay mirrors. $100 billion in estimated losses, depending on who's counting.

The torrents won. The content is in the swarm. It's not coming back.

But the metadata from that effort — the careful tagging, the complete discographies, the scene-level organization that torrent communities maintained with obsessive precision — that metadata is the most complete index of recorded music ever assembled. More complete than any label's catalog. More complete than Spotify's database. Built by people who cared about music enough to spend thousands of hours organizing it for free.

We take that index and turn it into the attribution layer the industry never built.

The pirates did the cataloging. The creators get the identity. The curators who connect them earn a commission. The industry that fought the pirates for a generation gets the one thing it never had: a sovereign, verifiable record of who made what and who's owed what.

Not because a label decided to publish credits. Not because Spotify chose to show songwriter names. Because the attribution is on-chain, signed by the artist, and nobody can edit it.

---

## The Economics

Artist claims their catalog. Free. No fee to claim what's yours.

Someone buys merch through the artist's DID. Streams through a sovereign player. Buys a ticket to a show. Licenses a track. Any transaction against that DID flows through .fair:

```
Protocol:  1%    → MJN (network equity)
Node:      0.5%  → operator
Buyer:     0.25% → buyer credit
Scope:     0.25% → scope fee (split with curator)
```

Artist keeps 98%. The .fair manifest splits their share among contributors — the band, the producer, the engineer. Automatically. Every time.

Compare: Spotify pays $0.004 per stream. The label takes 80%. The artist gets $0.0008. The session musicians get nothing unless they negotiated publishing, which most didn't. The songwriter gets a fraction of a fraction, processed through a collection society that takes 18 months to pay.

On Imajin, a fan pays $2 for a direct download through the artist's DID. The artist and their collaborators split $1.96 instantly, per the manifest they signed. The guitarist who played the session — the one Spotify doesn't know exists — gets their 10% because the artist put them on the manifest.

5,000 fans × $2/month = $120,000/year. Split fairly. Settled automatically. No label. No platform. No collection society.

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
