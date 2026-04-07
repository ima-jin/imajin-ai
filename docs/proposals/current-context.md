# Current Context
*Last updated: April 7, 2026*

This document tracks Ryan's current direction in the upstream repo and his responses — explicit or architectural — to the concerns in `outstanding-concerns.md`. It is a living document. As the upstream repo evolves, update this file to reflect what has moved, what has been acknowledged, and what remains open.

---

## Upstream Reference

Local clone: `upstream/` (read-only)
Remote: `https://github.com/ima-jin/imajin-ai`

**To update:**
```bash
cd upstream && git pull
```

**Current HEAD:** `227b2785` — April 7, 2026

---

## April 3–7 — Forest Infrastructure Sprint (Scope-Aware Everything)

**93 commits since April 3 (3bc931be → 227b2785).** Massive multi-tenant infrastructure buildout. Every userspace service is now scope-aware. Group identities, forest config, contextual onboarding, and launcher filtering all shipped.

### Forest Infrastructure (The Big Move)

**Group Identities (#587):** New `groupIdentities` and `groupControllers` tables in auth schema. Group DIDs (org/community/family) get real Ed25519 keypairs (server-generated, AES-256-GCM encrypted). Multi-controller access with role-based permissions (owner/admin/member). Service-scoped access via `allowedServices`. API: `POST/GET /api/groups`, `POST /api/groups/[groupDid]/controllers`. UI: `/groups` list page, `/groups/new` creation form ("Grow a Forest").

**Forest Config (#592, #593):** `forest_config` table in profile schema (`groupDid PK, enabledServices TEXT[], landingService TEXT, theme JSONB`). Admin settings page at `/groups/[groupDid]/settings` with four sections: service toggle grid, landing page selector, onboard URL generator, controller list with role badges. Public API at `GET /api/forest/[groupDid]/config/public` (no auth — lets launcher filter services for anonymous visitors).

**Forest Switcher (#588):** `useForests` hook reads groups from auth, manages `x-acting-as` cookie + localStorage. AppLauncher renders "Your Forests" section with scope icons and active forest checkmark. On switch: sets cookie/localStorage, reloads page.

**Contextual Onboard (#597):** `/onboard?scope={groupDid}` shows forest name/avatar/badge. Two flows: email verification (existing) and new keypair onboard (generate Ed25519 client-side via `@noble/ed25519`, download as JSON, register). Scope auto-join: if `scopeDid` provided, adds user as member + sets `x-acting-as` cookie + emits `scope.onboard` attestation.

**Scope-Aware Services (all 12 userspace):** Universal pattern: `const did = identity.actingAs || identity.id;` applied to every route in events, connections, pay, media, chat, coffee, learn, market, links, registry, notify, plus auth controllers. `requireAuth` validates `X-Acting-As` header against controllers table. `getSession` validates `x-acting-as` cookie (security fix — was previously unvalidated).

**Launcher as Landing Page:** `apps/www` root is now a service launcher grid with live network stats (ISR, 15-min revalidation). Forest-aware: if `localStorage['imajin:acting-as']` set, filters visible services to forest's `enabledServices`. Old content moved to `/project`.

### Fee Model v3 (`docs/rfcs/drafts/fee-model.md`)

Four-layer model replacing v2's three-party:

| Layer | Range | Default | Set by |
|-------|-------|---------|--------|
| Protocol (MJN) | 0.25%–2% | 1.0% | Governance |
| Node operator | 0.25%–2% | 0.5% | Node operator |
| Buyer credit | 0.25%–2% | 0.25% | Node operator |
| **Scope fee** (NEW) | 0%–no cap | 0.25% | Scope owner |

Default total: **2.0%** (was 1.75%). Scope fee is sovereign (no protocol-imposed ceiling), publicly advertised, market-governed. Mooi cited by name as example.

Additional: dual-token model (MJN equity/governance + MJNx stable at 1 CHF), gas fees (1¢ per non-economic op, 100% to node), platform affiliation (`relay_config.platform_did` + `forest_config.platform_did`), cross-platform settlement.

### DFOS 0.7.0 (#535)

Deleted 924 lines of custom ingest code. Adopted `@metalabel/dfos-protocol` library conformance. Relay auto-bootstraps identity on first boot (#575) — `RELAY_DID` removed from `.env.example`, persisted in `relay.relay_config` DB table.

### Connections Refactor (#577)

New first-class `connections` table (`did_a, did_b, connected_at, disconnected_at`). Migration backfills from 2-person pods. New `nicknames` table for per-user display name overrides. O(1) lookup by DID pair.

### Chat Improvements

- Nicknames (#579) — `useDidNames` hook fetches nicknames from connections, merges with auth names. Nicknames take priority.
- Reactions fix (#533) — `?? r.did` fallback for reaction sender DIDs.
- Group access (#582) — Restricted to conversation members/creator only.
- Group membership (#570/#571) — Add/remove members (owner/admin only), leave group (auto-promote oldest member if owner leaves). Attestations: `group.member.added`, `group.member.removed`, `group.member.left`.

### Other

- **Light mode (#534)** — Dark/light toggle in NavBar, persisted in localStorage, applied across all services via `theme-init.ts`.
- **OG metadata (#8)** — 7 services gained social cards (coffee, links, learn, connections, dykil, market, media).
- **RFC-24 (Knowledge Surfaces)** — Draft. Profiles as queryable knowledge surfaces: MCP server, organizational skill, learn, profile, .fair.
- **Work order wo-602-scope-aware-services** — Documents the actingAs pattern for all 11 services.

### Impact on Proposals/Concerns

| Item | Change |
|------|--------|
| **P32 (Mooi)** | Near-complete. Forest config + contextual onboard + scope-aware services + launcher filtering = everything P32 proposed minus crowd-funded events and BBS/forum view |
| **P10 (Org DID)** | Schema + API complete. Group identities with keypairs, controllers, service-scoped permissions. External vetting gap remains |
| **P25 (Family DID)** | Schema complete (`scope: 'family'` in group identities) |
| **P23 (Node Operator)** | Substantially advanced. Two revenue streams (fee + gas), forest config gives UI control |
| **P31 (Fee Governance)** | v3 supersedes. Scope fee is the new layer |
| **P14 (Governance Equity)** | Service-scoped controller access is a governance primitive |
| **P29 (Attestation)** | 5 new types (group.created, group.member.added/removed/left, scope.onboard). Total 24. institution.verified still disabled |
| **C10 (Relay)** | DFOS 0.7.0 + auto-bootstrap. Cross-service auth middleware still TODO |
| **C11 (isValidDID)** | Still broken. No changes to keypair.ts |
| **C16 (Family DID)** | Schema complete via group identities |

---

## April 1–3 — Launch Window + Post-Launch Velocity

**55 commits since March 30 (a3260d1c → 3bc931be).** +19,150 / -3,597 lines across 242 files. April 1 infrastructure confirmed live. Post-launch features (refunds, broadcast, hybrid events) shipping within 48 hours.

### What shipped (PRs #536–566, March 30–April 3)

**Events features (April 1):**
- #559 — Hybrid virtual+physical events (`location_type` schema). Virtual URL gated to ticket holders on event day.
- #557 — Check-in webhook + WLED bridge (`scripts/wled-bridge.mjs`) — IoT LED flash on ticket scan
- #554 — Event host broadcast messaging — markdown composer, contextual emails with reply-to organizer

**Email infrastructure (March 31–April 1):**
- #549 — Registry: interest metadata + DID consent preferences (`interests`, `did_preferences`, `did_interests` tables)
- #550 — Notify: broadcast + unsubscribe + interest signals. RFC 8058 one-click unsubscribe. CAN-SPAM compliance.
- Interest signals wired to events, coffee, connections, chat, market attestation types

**Refunds (April 2–3):**
- #561 — End-to-end ticket refunds: events → pay → Stripe
- Settlement entries reversed on refund (3bc931be)
- Notification email to attendees

**RFCs:**
- RFC-22 rewritten three times → final: consent-and-sign redirect as primary cross-platform auth
- RFC-23 published (April 1) — multi-chain settlement: Solana + Cardano + Midnight, privacy-routed
- RFC-19 updated — embedded relay section: every node runs local DFOS relay as data layer

**Service changes:**
- `apps/input` **retired** entirely. Transcribe route moved to `apps/media`. Retire doc at `docs/migrations/retire-input-service.md`.
- `apps/notify` takes input's port (3008). Service count remains 15.

**Other:**
- PR #526 merged — our P31 + questions-for-ryan in upstream `docs/proposals/`
- Cost estimate updated: Day 57, 132K LOC, $93K vs. $2.5M COCOMO (27×)
- Discussion #544: Sovereign Audio Sampler — first external dev project on Imajin stack
- `institution.verified` attestation disabled (e8a28a1e) — event DIDs lack keypairs
- CI security audit job added (pnpm audit on production deps)

### Impact on proposals/concerns
- **P29** — `institution.verified` regressed (18/26 seams, was 19/26)
- **C12** — DID consent preferences + unsubscribe shipped; protocol-level consent still TODO
- **P28** — April 1 confirmed live; refunds shipping = post-demo velocity
- **P31** — merged upstream; RFC-23 adds multi-chain dimension
- **C10** — RFC-22 finalized (consent-and-sign redirect); relay middleware still missing

---

## March 28–30 Sprint — Pre-Launch Push

**33 commits since March 27 HEAD (6d20fb8).** The most significant sprint since the DFOS bridge in March 21–22. Focus: auth hardening, DFOS integration, settlement wiring, new RFCs.

### What shipped (PRs #522–532, merged March 29–30)

**Auth overhaul (8 PRs):**
- #522 — Generate missing migrations for auth, profile, notify
- #523 — Clean up login form, remove chain login, add newsletter
- #524 — Email MFA setup, password setup, remove TOTP gate
- #525 — Post-deploy batch 2: notify fixes, drizzle docs, article slug
- #528 — Password login: base64 decoding + JSON keypair parsing
- #529 — Notify: Tailwind + NavBar styling fixes
- d65cad73 — PBKDF2 iterations aligned (100000 setup / 310000 login mismatch fixed)

**DFOS relay (2 PRs):**
- #527 — Sequencer loop for out-of-order op handling
- #531 — Return rejected for missing-dep ops, keep pending for sequencer

**Auth bridge to DFOS (#532):**
- `apps/auth/lib/dfos.ts` — `verifyClientChain()`, `storeDfosChain()`, `ingestToRelay()`
- Register flow creates DFOS genesis on register
- Login flow lazily backfills DFOS chain on login
- Non-fatal — never breaks auth or login

**Settlement wiring:**
- `apps/events/src/lib/settle.ts` — `settleTicketPurchase()` calls `POST /api/settle`
- Events payment webhook invokes settlement on every Stripe checkout
- Platform fee deducted at 3% (`PLATFORM_FEE_PERCENT`) before attribution chain

**UI:**
- ActionSheet component + chat MessageBubble migration (#530)
- Notify: auth guard, settings page, complete .env.example

### New RFCs (draft status)

| RFC | What it specifies |
|-----|------------------|
| **RFC-20** (Application Conformance Suite) | Three-layer conformance model for DFOS projector semantics: protocol, chain-type, userspace |
| **RFC-21** (Imajin Conformance Suite) | Executable spec for node compliance: settlement (1% + 0.5% + 0.25%), gas, rate change tests |
| **RFC-22** (Federated Authentication) | Cross-relay auth without private key exposure; four key custody tiers (custodial KMS, stored key, self-custody, local-first) |
| **Fee Model v2** | Three-party fees (1% protocol + 0.5% node + 0.25% user = 1.75% default); replaces original 1% split model |

### Migration discipline tightened
- `drizzle-kit push` banned (commit 721129d1)
- CI checks migration consistency (`scripts/check-migrations.sh`)
- Three artifacts required per migration: .sql + journal entry + snapshot
- Build fails on migration error

### Impact on our proposals/concerns
- **P8 → RESOLVED** — settlement wiring live
- **C18 → RESOLVED** — all demo blockers addressed
- **C10 → PARTIALLY RESOLVED** — RFC-22 provides architecture; relay write middleware still missing
- **P31 → SUPERSEDED** by fee model v2 (governance mechanism adopted, rates restructured)
- **C11 → UNCHANGED** — `isValidDID()` / `createDID()` bugs persist

---

## P26 Epic + Relay — March 22–23, 2026

**Upstream HEAD: `800bfe1` — March 23, 2026**

The fastest proposal-to-implementation turnaround in the project. P26 (DFOS Adoption Audit) was filed March 22; all 10 issues shipped the same day. P27 (Unified Identity Substrate) thesis adopted same day as filing.

### What shipped (PRs #437–457, merged March 22–23)

**PR #437** — Auth consolidation + dfos-protocol 0.2.0: all services on `@imajin/auth` wrappers.

**PR #440 — Batch 1 Foundation:**
- `chainVerified` added to session/Identity response — `auth.identity_chains` checked on every auth
- `institution.verified` added to `packages/auth/src/types/attestation.ts` vocabulary (P27 Decision #7 RESOLVED)
- Events check-in emits `institution.verified` attestation — the door-check operation is real

**PR #441** — Registry: chain-verified node registration + `/api/identity/verify-chain` endpoint.

**PR #442** — .fair: portable attribution with chain-backed creator proof.

**PR #443** — Pay: chain-verified settlement parties.

**PR #444** — Connections: pod membership emits `pod.member.added`/`pod.member.removed`/`pod.role.changed` attestations.

**PR #445** — Learn: `learn.enrolled` + `learn.completed` chain-linked attestations.

**PR #446** — Chat: signed messages with chain keys (opt-in, federation prep).

**PR #447 — Chain provider abstraction + external chain onboarding:**
- `lib/chain-providers.ts` — pluggable `ChainProvider` interface, dfos provider registered
- `POST /api/identity/present-chain` — external user presents DFOS chain → `did:imajin` alias + `tier: 'preliminary'` session (P27 Decision #4 RESOLVED)
- `POST /api/identity/verify-chain` — internal service-to-service chain verification

**PR #451** — Auth integration test suite: 43 tests, `imajin_test` DB, CI wired.

**PR #453 — DFOS Web Relay LIVE:**
- `@metalabel/dfos-web-relay` v0.3.0 in registry at `/relay/[[...path]]`
- `PostgresRelayStore` with full relay tables (operations, identity chains, content chains, beacons, blobs, countersignatures)
- Live at `dev-registry.imajin.ai/relay/`
- P27 Decision #6 RESOLVED: relay ships with node, not optional

**PR #457** — OpenAPI specs generated for all 15 services.

### P27 thesis adopted
Build timeline: *"Greg's strongest architectural proposal yet. Core thesis adopted. One DID, not two. did:imajin becomes an alias (like DNS), the chain is canonical identity."*
- Decisions #4, #6, #7 — RESOLVED in code
- Decisions #1, #2, #3, #5, #8 — still open

### C01 (Social Graph Portability) — substantially resolved
Trust relationships are now attestation records on chains. Pod membership chain-recorded. External chain presentation means portability is mathematical, not contractual. Full federation runtime requires multi-node relay propagation.

---

## DFOS Sprint — March 21–22, 2026

This was the largest single sprint since market launch. 48 commits across ~30 hours. The core story: DFOS DID Bridge goes from filed issues to fully shipped tech debt cleared in one session.

### What shipped

**PR #407 (merged March 21) — DFOS DID Bridge Phase 1+2**
- `packages/dfos`: `bridge.ts`, `signer.ts`, `index.ts` — chain creation, verification, DFOS DID prefix
- `auth.identity_chains` table (`0003_brave_avengers.sql`) — links `did:imajin` ↔ `did:dfos`, stores full chain log as JSONB + `head_cid`
- Register and login routes now create DFOS chains at first login for preliminary/hard DIDs
- Same Ed25519 keypair → Imajin DID + DFOS chain

**PR #412 (merged March 22) — Chain resolution endpoints (#398)**
- Auth now serves chain resolution: bidirectional lookup, `did:dfos` ↔ `did:imajin`

**PR #413 (merged March 22) — Chain-aware auth middleware (#403)**
- `lib/middleware.ts` — chain awareness wired into the auth middleware layer

**PR #426 (merged March 22) — DFOS sprint: key rotation + CID + countersignatures**
This PR paid off all three DEBT.md items that were marked deferred:
- **#400 DAG-CBOR** → `packages/cid` shipped — `computeCid()` / `verifyCid()` using `@ipld/dag-cbor` + SHA-256
- **#401 Key rotation** → `0004_key_rotation.sql` — `key_roles` JSONB column on `auth.identities`, `key_id`/`key_role` on `auth.tokens`; new routes: `/api/identity/[did]/keys`, `/api/identity/[did]/rotate`
- **#402 Countersignatures** → `0005_content_addressing.sql` — `cid`, `author_jws`, `witness_jws`, `attestation_status` columns on `auth.attestations`; countersign + decline routes live; `emit-session-attestation.ts` — attestations emitted on session start

**PR #431 (merged March 22) — DFOS sprint megamerge**
- `profile.email → contact_email` refactor — auth now owns email identity, profile stores contact preference
- Market fixes: upload images to media service (not data URLs), seller name from auth not profile
- Auth: unified email-first login page (`/app/api/login`)

**PR #434 (merged March 22) — Keys-first login + gas fees + essay 31**
- Keys-first login flow: if a stored keypair is found, auto-login without password prompt
- Gas fee implementation: established DID email login costs 0.01 MJN (up from 0.001)
- `essay-31-the-receipt.md`: conceptual foundation for MJN token launch — virtual MJN minted into chains as usage proof; when real MJN arrives, it recognizes existing value
- Nav bar balance reads `data.total` not `data.amount` (bugfix)

**PR #436 (merged March 22) — Chat v2 migration complete**
- v1 tables dropped (`0002_drop_v1_tables.sql`), v2 is now the only schema
- Migration script (`scripts/migrate-v1-to-v2.ts`) for any existing data

### New packages
| Package | What it is |
|---------|-----------|
| `packages/dfos` | DFOS DID bridge — chain creation, verification, signer |
| `packages/cid` | DAG-CBOR content addressing — deterministic CIDs for any JSON object |
| `packages/llm` | Vercel AI SDK wrapper + platform tools (events, connections, attestations, profile, pay, learn, media) |

### `packages/llm` — RFC-16 Progress
The `@imajin/llm` package is direct implementation of RFC-16 (Jin Workspace Agent). It provides:
- Provider factory (Anthropic, OpenAI, Ollama) via Vercel AI SDK
- Cost tracking from token usage
- Platform tool bundles: `createPresenceTools`, `createEventTools`, `createConnectionTools`, `createAttestationTools`, `createProfileTools`, `createPayTools`, `createLearnTools`, `createMediaTools`

This is the agent tool layer — Jin can now call any platform service programmatically with bounded scope (`targetDid`, `requesterDid`, `trustDistance`).

### Stale documents noted
- `docs/DEBT.md` still lists #400/#401/#402 as deferred — these are all shipped. Not a blocker but worth knowing.
- `docs/IDENTITY_ROADMAP.md` was written before attestations and the three-tier model shipped — many "doesn't exist" items now exist.

---

## Previous Upstream Activity (March 13–21, 2026)

*(Condensed — see memory and prior proposals for detail)*

- **Stable DID migration (#371)** — soft DIDs now `did:imajin:{nanoid(44)}`; email in `auth.credentials`
- **Magic link re-auth (#368)** — `POST /api/session/magic-link`, restricted to soft DIDs
- **Agent-principal pairing (#366)** — agent DID requires established-tier principal; `principal_did` + `image_id` on `auth.identities`
- **Market app shipped** (apps/market, port 3104/7104) — listings, seller dashboard, purchase flow, Stripe
- **Toast component** — replaced 48 `alert()` calls across 9 apps
- **RFC-17: Governance Primitive** — `docs/rfcs/RFC-17-governance-primitive.md`; discussion #410 opened
- **DFOS DID Bridge filed** — issues #395–400 filed March 21 (now all merged)
- **PR #406 merged** — our P21–P25 proposals now in upstream `docs/proposals/`

---

## Previous Upstream Activity (March 10, 2026)

- `refactor: replace self-fetching pages with direct DB queries (#190)` — profile, links, coffee pages now query DB directly
- `fix: update .env.example files + add check-env validation script (#191)` — new `scripts/check-env.ts`
- `feat: unified build.sh with --dev/--prod flag`
- `refactor: remove fixready/karaoke from service manifest — connected apps use plugin arch (#249)`
- `feat: shared service manifest + session cookie in @imajin/config (#227, #270)`
- `docs: MJN whitepaper v0.2 — typed identity primitives`

**Key docs to read in upstream:**
- `docs/rfcs/RFC-16-jin-workspace-agent.md` — Jin agent architecture + `packages/llm` implementation
- `docs/rfcs/RFC-17-governance-primitive.md` — governance primitive for all 4 identity scopes
- `docs/mjn-whitepaper.md` — now includes embedded wallet architecture
- `apps/www/articles/essay-31-the-receipt.md` — conceptual foundation for MJN token launch
- `docs/SETTLEMENT_ROADMAP.md` — settlement phases and current state

---

## Status of Outstanding Concerns

### CRITICAL — Social Graph Portability
**Status: SUBSTANTIALLY RESOLVED — portability is now mathematical**

DFOS DID Bridge (Phase 1+2, PR #407) is now live. `auth.identity_chains` stores the chain log as JSONB. This is the cryptographic portability layer — a chain can be exported and verified by anyone with the spec. Combined with RFC-10 (Sovereign User Data), the portability story is now chain-first: your identity bundle is verifiable without trusting our DB.

**Update from RFC-001:** Chain resolution endpoints (PR #412) now let services look up `did:dfos` ↔ `did:imajin` bidirectionally. The registry DID-to-endpoint resolution (#155) is the next critical gap.

**What still needs specification:**
- Delta sync (incremental chain updates vs. full export)
- E2EE chat key escrow for backup
- Registry DID resolution endpoint — #155

*(Previous status: In Active Development (RFC-001 filed))*

---

### CRITICAL — Social Graph Portability (previous detail)
**Status: In Active Development (RFC-001 filed)**

Ryan filed `RFC-001: Identity Portability & Backup Nodes` (`upstream/docs/rfcs/RFC-001-identity-portability.md`). This is the most direct existing response to the outstanding concern.

**What it addresses:**
The RFC defines a full **Identity Context Package** — not just keypair portability but full context portability:

```
identity-package/
├── identity.json       # DID document, public key, metadata
├── connections.json    # Trust graph (who you know, trust levels)
├── fair/               # .fair manifests (attribution records)
├── media/              # Asset references + optional encrypted blobs
├── transactions.json   # Payment/settlement history
├── conversations.json  # Chat metadata
└── manifest.json       # Package version, created_at, signature
```

Trust relationships are intended to be user-owned and exportable — not node-locked. Three tiers of resilience: encrypted export (manual), backup nodes (automated sync), on-chain registry (Tier 3, depends on MJN token).

**What remains open from the RFC itself:**
- Delta sync (full package per sync is wasteful)
- Incremental sync strategy
- E2EE chat key escrow for backup
- How new contacts find you after failover (DNS update vs. on-chain pointer)
- Revocation of a rogue backup node

**Assessment:** The concern is being addressed. The architecture points toward DID-stored (portable) trust relationships, not node-stored ones. The sovereignty claim is becoming load-bearing as the RFC progresses. Track implementation tickets when RFC is accepted.

---

### CRITICAL — .fair Attribution for Automated Nodes
**Status: Partial — on-chain anchoring established, enforcement layer unspecified**

The Embedded Wallet RFC (March 9, 2026 — see `current-proposals.md`) adds on-chain settlement with an important property: `.fair manifest hash is recorded on-chain as provenance`. This means .fair attribution records can be anchored immutably to a transaction hash on Solana.

**What this adds:**
- Client-side signing of transactions — private key never touches the server
- .fair manifest hash on-chain = tamper-evident record
- Atomic splits: all contributors settle or none do

**What still needs specification:**
The original concern — who writes the .fair manifest for machine-to-machine calls in Stream 3 — is still unaddressed. On-chain anchoring helps with *verifiability* once a manifest exists, but doesn't specify how automated nodes generate or sign those manifests. The gap is the originating DID signing requirement for agent-generated manifests.

---

### DESIGN — Governance Equity vs. Economic Equity
**Status: Partially addressed through Progressive Trust Model**

The Progressive Trust Model (see `current-proposals.md`) introduces a standing tier structure that clarifies who holds governance weight and under what conditions. Established DIDs earn governance eligibility through demonstrated participation — vouching, event attendance, network interactions — not just Stream 5 (inference).

This doesn't fully resolve the asymmetry between economic and governance participation, but it separates governance weight from inference/AI participation specifically. Governance is now earned through *any* form of network engagement at sufficient depth, not exclusively through running personal AI.

**Still needs documentation:** The explicit statement that the system provides economic equity for all participants and governance influence scales with demonstrated participation — not AI ownership.

---

### DESIGN — Vetting and Early-Member Influence (Org DID)
**Status: No upstream movement yet**

Not addressed in recent commits. The Trust Accountability Framework proposal (see `current-proposals.md`) establishes the vouch chain accountability model but doesn't resolve the compounding influence question for early members in Org DID vetting.

---

### CALIBRATION — Gas Model Ceiling (Stream 2)
**Status: Auth gas implemented; Stream 2 gas still open**

PR #434 shipped gas fees for authentication: established DID email login costs 0.01 MJN (chain entry). Essay 31 ("The Receipt") describes virtual MJN minted into chains as usage proof — this is the economic foundation for the MJN launch, not Stream 2 commercial reach.

**Distinction matters:** P11 (Gas Model Ceiling) addresses frequency-scaled gas for the Declared-Intent Marketplace (Stream 2). Stream 2 itself doesn't exist yet. The gas implementation in PR #434 is auth-layer gas — different system. P11 remains fully open and is still the right design, but its dependency (Stream 2 schema) doesn't exist yet.

Per-recipient rate limiting and frequency-scaled multipliers are still an open design question.

---

### CALIBRATION — Declaration Granularity Standards (Stream 2)
**Status: No upstream movement**

No .fair-equivalent standard for declaration categories has been specified.

---

### SPECIFICATION — Cultural DID Open Questions
**Status: Discussion open (#247), no implementation**

GitHub Discussion #247 is open. The Progressive Trust Model proposal uses "token context" as a participation qualifier (trust graph depth, .fair contribution history, attestation count, activity recency) — this begins to answer the open question about what the formation threshold is made of. Full specification pending.

---

## Ryan's New Contributions (March 2026)

### MJN Whitepaper v0.2 — Typed Identity Primitives
`upstream/docs/mjn-whitepaper.md`

The protocol spec has grown to explicitly position MJN at the application layer above HTTP:
```
MJN          ← identity + attribution + consent + settlement
HTTP/WS      ← transport
TCP/IP       ← packets
```

Every MJN exchange now carries: verified sender identity (DID), attribution manifest (.fair), consent declaration, and settlement instruction — defined as protocol primitives, not optional headers. This is Ryan formalizing what was previously implicit in the architecture.

The Foundation model is explicit: Swiss Stiftung, open protocol, Imajin Inc. as reference operator. The protocol/product split (HTML/HTTP vs. Netscape/Chrome analogy) is now in the whitepaper.

### "The Practice" Essay
`upstream/apps/www/articles/essay-09-nodes-types-and-practice.md`

Ryan's essay on the arc from individual identity → event → family → community → business. Notable for how it defines the **operator role** as distinct from the technical builder role: pattern recognition across human systems, holding multiple rooms simultaneously, caring about the culture of a room. AI collapsed the technical barrier; judgment is the scarce resource.

Also introduces the **business cold-start inversion**: don't ask businesses to join, let their customers accumulate a presence on the network first, then the business claims what their community already built.

### Plugin Architecture (#249)
`fixready` and `karaoke` removed from service manifest — connected apps now live in separate repos and consume the platform via plugin architecture. The monorepo no longer owns client apps. This is the first implementation step toward the Application Plugin Architecture RFC (#254).

### Key Backup Format Fix (#268)
Mismatch between register and login key backup formats resolved. Directly relevant to the Embedded Wallet work — the backup file is now the de facto wallet backup.

### Shared Service Manifest (#227, #270)
`@imajin/config` now provides a shared service manifest and session cookie configuration across all apps. Reduces per-app configuration drift.

---

## Acknowledgements from Ryan

*This section records when Ryan explicitly acknowledges proposals from this workspace or the discussions threads. Update as they occur.*

- **Progressive Trust Model** — Core concept from Greg Mulholland's "Entering the Network" (March 2026). Architectural grounding by Ryan and Jin. Ryan refined the model to use graduated permissions on existing DID types rather than introducing new DID types. Related: #247, #248, #244. Jin posted a clarifying comment to Discussion #271 on March 10 (see below).
- **Cultural DID** — Greg's proposal migrated to Discussion #252 (previously #247). Now live in upstream discussions.
- **Commons Layer / Community Issuance Network** — Greg's proposal now live as Discussion #272 in upstream.
- **Trust Accountability Framework** — Bad actor model from Greg Mulholland's "Entering the Network" (March 2026). Live as Discussion #273.
- **Embedded Wallet** — Discovered architecturally on March 9, 2026, during discussion between Ryan and Jin. Live as Discussion #268.

### Jin's Comment on #271 (March 10, 2026)

Jin (`@imajin-jin`) posted a clarification to the Progressive Trust Model discussion:

> *"Preliminary DIDs can receive and accept connections from established DIDs. They can message within those direct connections. What they can't do is vouch, invite, or initiate connections to other preliminary DIDs. The network comes to you through people who are already trusted. [...] This means the preliminary phase is immediately useful — you're not in a waiting room. [...] The restriction is on outbound trust actions (vouching, inviting), not on inbound relationships."*

This is already reflected in `current-proposals.md §1` and is consistent with the proposal as written.
