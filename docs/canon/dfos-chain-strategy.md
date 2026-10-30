# epic: DFOS chain strategy — federated data across the Imajin network

> **Canon** · source: [ima-jin/imajin-ai#555](https://github.com/ima-jin/imajin-ai/issues/555) · filed 2026-04-01 by @imajin-jin · carried into docs 2026-10-26
>
> Ruled 2026-10-26 (pre-cut issue audit v0.8.28, card 11, option c): canon lives in `docs/canon/` now, and the corpus reads it from here later. The issue stays open until this lands.
>
> By **Veteze-Jin**: Ryan's thesis, translated by Jin (an AI) and signed as a translation. Anything quoted from Ryan is verbatim.

## Thesis

Every meaningful piece of data on Imajin is portable. If a user leaves, they take everything with them. If Imajin disappears, the relay network still holds the proof. DFOS chains are the vehicle.

## Source (verbatim from [#555](https://github.com/ima-jin/imajin-ai/issues/555))

### Vision

Every meaningful piece of data on Imajin should be portable. If a user leaves, they take everything with them. If Imajin disappears, the relay network still holds the proof. DFOS chains are the vehicle.

### UCAN Authorization Layer (April 14, 2026)

Brandon's latest design crystallizes how platform authz meets protocol delegation:

**Key insight:** Platform absorbs all access control complexity (roles, permissions, scoping). Protocol only sees UCAN delegation chains. Our `identity_members` role hierarchy (`owner` → `admin` → `maintainer` → `member`) stays internal — the protocol just sees "valid delegation from chain owner to signer."

#### Three-Party Signing
- **Chain owner** (space/community/node DID) — signs genesis op
- **Operation signer** (ephemeral device key) — browser-generated, signs locally
- **Author** (`createdByDID` in payload) — the actual user

UCAN chain links all three cryptographically. Enables local signing with browser-generated keys — no KMS call per write. This unlocks mobile-first and offline-first.

#### How It Maps to Our Architecture
- **`requireAuth()` + `identity_members`** = platform-side authz. Issues JIT UCANs when role check passes. Protocol never sees role hierarchy.
- **Conversations** = topic chains. Each conversation DID becomes a chain genesis. Messages are chain operations.
- **Attestations** = chain operations. Signed, content-addressed. Postgres becomes read cache.
- **RFC-22 (federated auth)** = replaced by UCAN verification. No handshake needed — delegation chain is self-verifying.
- **Agent delegation ([#394](https://github.com/ima-jin/imajin-ai/issues/394), [#366](https://github.com/ima-jin/imajin-ai/issues/366))** = UCAN delegation chains. Agent sub-identity gets scoped UCAN from principal.
- **App sessions ([#244](https://github.com/ima-jin/imajin-ai/issues/244))** = UCAN delegation to third-party app DID with scope constraints.

#### Revocation
Protocol-level: signed revocation artifacts gossiped as beacons (not content chains). Issuer signs "I revoke UCAN with CID X," relays propagate. Re-authorization = new UCAN.

#### Implementation Path
1. Define UCAN credential schema for Imajin (extends existing `identity_members` decisions)
2. Add UCAN issuance to `requireAuth()` / act-as flow
3. Ephemeral key generation in browser, UCAN delegation on auth
4. Sign chain operations with ephemeral key + UCAN proof
5. Relay verification checks UCAN chain + revocation set

Reference: https://app.dfos.com/spaces/space_n92ker4fftd332d8hr7ddd/chat/channel_87e43tha4cettehe7dhdan?thread=msg_fvan3fv7dntact3z2ekr9d

---

### Chain Types

Each chain type uses a custom `$schema` payload that DFOS carries but does not interpret. Imajin defines the vocabulary, DFOS handles federation and replication.

#### 1. Identity (done)
- **Per:** DID
- **Type:** identity chain (DFOS native)
- **Federates:** keys, rotation, recovery
- **Status:** ✅ Live — genesis chains created at registration, ingested to relay

#### 2. Attestations (first priority)
- **Per:** DID (one chain per identity, append-only)
- **Type:** content chain
- **Schema:** `https://schemas.imajin.ai/attestation/v1`
- **Federates:** trust signals — `ticket.purchased`, `event.created`, `tip.received`, `connection.accepted`, `vouch`, etc.
- **Why:** Feeds the trust graph. Diversity × age × volume = standing. Chain = federated reputation. Also: chain entries = mint proof for MJN token launch.
- **Bridge:** `emitAttestation()` in auth already fires for ~20 types across 15 services. Add chain append alongside Postgres insert.
- **Visibility:** Chain is obfuscated. Registry computes standing and exposes tiered access:
  - Public: badge + level (soft/preliminary/established)
  - Authorized apps: detailed breakdown by category
  - Node operators: full chain access for independent verification

#### 3. Settlements
- **Per:** DID (one chain per identity)
- **Type:** content chain
- **Schema:** `https://schemas.imajin.ai/settlement/v1`
- **Federates:** payment proofs — amount, currency, counterparty, context (ticket, listing, tip)
- **Why:** Economic activity proof. Direct bridge to MJN — `verify_and_mint()` replays settlement chains. Per-DID claims via chain proof replay. If Imajin disappears, anyone with relay data + contract can still mint.
- **Bridge:** Pay service settlement endpoint appends to chain after Stripe confirms.

#### 4. Connections
- **Per:** DID (one chain per identity)
- **Type:** content chain
- **Schema:** `https://schemas.imajin.ai/connection/v1`
- **Federates:** social graph — connections, pods, group memberships
- **Why:** Portability. Leave a platform, keep your friends. The "bring your social graph" promise.
- **Bridge:** Connections service appends on invite accept, pod join/leave.

#### 5. .fair Manifests
- **Per:** work (one chain per creative work)
- **Type:** artifact
- **Schema:** `https://schemas.imajin.ai/fair/v1`
- **Federates:** attribution, provenance, content-addressed creative history
- **Why:** A creator's .fair chain = their portable creative portfolio. Signed, verifiable, independent of any platform.

#### 6. App Registry
- **Per:** node
- **Type:** content chain
- **Schema:** `https://schemas.imajin.ai/app-registry/v1`
- **Federates:** app registrations, scopes, compliance status
- **Why:** Decentralized app discovery. Any node can discover and verify apps across the network. The "app store" is the relay network.

#### 7. Events
- **Per:** event
- **Type:** artifact
- **Schema:** `https://schemas.imajin.ai/event/v1`
- **Federates:** event listings, discoverability
- **Why:** "What's happening in Toronto this weekend" across multiple nodes.

### Priority Order

1. **Attestations** — trust graph, MJN mint proof, most types already emitting
2. **Settlements** — economic proof, MJN bridge
3. **Connections** — social portability
4. **.fair / Events / App Registry** — discoverability layer

### Architecture

- Each chain type gets its own `$schema` — DFOS is schema-agnostic
- Auth service is the signing authority for per-DID chains (attestations, settlements, connections)
- Apps emit events fire-and-forget → auth appends to chain + writes to Postgres
- Postgres = fast read cache. Chain = federated proof.
- Registry replays chains to compute trust scores, standings, and network state
- Brandon's Go CLI (`dfos serve`) means any node can replay and verify independently
- **UCAN delegation** handles all cross-DID authorization — platform issues JIT credentials, protocol verifies cryptographic chains

### Child Issues

- [ ] [#556](https://github.com/ima-jin/imajin-ai/issues/556) — Attestation chains (first implementation)
- [ ] [#640](https://github.com/ima-jin/imajin-ai/issues/640) — Emit attestations as DFOS chain entries alongside DB writes
- [ ] [#454](https://github.com/ima-jin/imajin-ai/issues/454) — Wire up authZ on DFOS relay (UCAN-based)
- [ ] [#600](https://github.com/ima-jin/imajin-ai/issues/600) — Federated peer onboarding (UCAN replaces handshake)
- [ ] [#458](https://github.com/ima-jin/imajin-ai/issues/458) — Encrypted group chat (key epochs + chain-per-conversation)
- [ ] [#244](https://github.com/ima-jin/imajin-ai/issues/244) — Delegated app sessions (UCAN delegation to third-party apps)
- [ ] [#394](https://github.com/ima-jin/imajin-ai/issues/394) — Agent sub-identities (UCAN delegation chains)
- [ ] [#366](https://github.com/ima-jin/imajin-ai/issues/366) — Agent-principal pairing (custody = UCAN delegation)
- [ ] Settlements on chain (TBD)
- [ ] Connections on chain (TBD)
- [ ] .fair manifests as artifacts (TBD)
- [ ] App registry federation (TBD)
- [ ] Event listing federation (TBD)

### Related

- [#163](https://github.com/ima-jin/imajin-ai/issues/163) — Bilateral attestations (original concept)
- [#405](https://github.com/ima-jin/imajin-ai/issues/405) — DFOS integration Phase 2
- [#516](https://github.com/ima-jin/imajin-ai/issues/516) — Countersignature for trust-critical types
- [#395](https://github.com/ima-jin/imajin-ai/issues/395) — DFOS DID bridge epic (identity chains — done)
- [#336](https://github.com/ima-jin/imajin-ai/issues/336) — Trust graph query engine
- RFC-20 — Application conformance (chain type rules)
- RFC-21 — Conformance suite (node rules)
- RFC-22 — Federated authentication (superseded by UCAN)
- RFC-26 — Federated handle resolution
- Fee model v4 — MJN mint via settlement chain replay

### Folded in

**From [#510](https://github.com/ima-jin/imajin-ai/issues/510) — feat(settlement): Platform DID as scope-level peering config:**
- Platform DID as scope-level peering config is a DFOS federation primitive: it determines whether a forest operates in sovereign mode (platform fee stays local) or peering mode (platform fee routes to a parent). This is a settlement-layer concern within the DFOS chain strategy.

**From [#556](https://github.com/ima-jin/imajin-ai/issues/556) — feat: DFOS attestation chains:**
- DFOS attestation chains (writing attestations as chain entries with Imajin schema) are the core data-portability mechanism of the DFOS chain strategy. One chain per DID, attestations as content operations, Postgres as read cache. This is the chain-layer implementation of the DFOS strategy.



**From [#1129](https://github.com/ima-jin/imajin-ai/issues/1129) — Epic: DFOS × Imajin coordination layer:**
- The DFOS × Imajin coordination layer (compose mcp.dfos.com onBehalfOf the human) is a federation consumer of the DFOS chain strategy. It maps DFOS verbs to Imajin primitives (discovery, communication, attestation, media, identity) and acts as a read/coordinate bridge. This is a vertical integration of the DFOS strategy, not a separate protocol.

**From [#1130](https://github.com/ima-jin/imajin-ai/issues/1130) — feat: map DFOS verbs → Imajin primitives:**
- Mapping DFOS verbs to Imajin primitives is the surface design of the DFOS coordination layer. The 58 DFOS MCP tools project onto Imajin's 5 primitives so the agent reaches DFOS through Imajin vocabulary. This is the design layer of the DFOS coordination epic.

**From [#1131](https://github.com/ima-jin/imajin-ai/issues/1131) — feat: per-principal OAuth for DFOS:**
- Per-principal OAuth for DFOS is the multi-user productization gate of the coordination layer. Each member connects their own DFOS identity; the agent acts onBehalfOf each with per-principal token storage. This is the auth layer of the DFOS coordination epic.



**From [#1132](https://github.com/ima-jin/imajin-ai/issues/1132) — feat: DFOS notifications → Imajin notify:**
- DFOS notification bridging (poll-based, de-duped, scoped to Imajin notify) is a coordination-layer feature. It maps DFOS activity events into Imajin's notification system, treating DFOS as the first instance of "external-MCP activity feed → Imajin notify." This is a notification integration within the DFOS coordination epic.

**From [#1381](https://github.com/ima-jin/imajin-ai/issues/1381) — feat(connectors): DFOS connector:**
- The DFOS connector (registry entry, scope-manifest, per-DID grants) is the connector-framework integration of the DFOS coordination layer. It seals DFOS OAuth tokens per-DID in the kernel vault and exposes `dfos_*` tools through the connector rail. This is the connector-layer implementation of the DFOS coordination epic.

## Rulings and notes from the thread

**@imajin-jin · 2026-07-13**

> **Recomposition note (2026-07-12):** verified against code — the Phase-1/Phase-2 seam is already implemented and waiting. `packages/bus/src/reactors/dfos.ts` (`dfosReactor`) is a deliberate Phase-1 no-op gated behind `config.directChainWrite ?? false`; its comment marks the exact insertion point ("Phase 2: direct chain append via @imajin/dfos bridge", with `createIdentityChain`/`updateIdentityChain` stubbed as a commented import). `emitAttestation()` currently only POSTs to `auth/api/attestations/internal` → Postgres; no content flows to DFOS chains yet. So this epic is "buildable when we flip `directChainWrite` + wire the bridge" rather than greenfield. Whether the relay accepts content-typed (non-identity) chains is a DFOS-spec question (Brandon's side, relay 0.13.5) that's moot until we emit them. — Jin
