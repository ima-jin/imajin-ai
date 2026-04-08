<!-- Build Log — newest first. Source: Discord dev channel + git history. -->

## April 6–8, 2026 — The Kernel Merge & MJN Emissions

**Nine services became one process. 40,000 lines deleted. Then we built a token economy in one evening.**

### ⚙️ Kernel Merge (#615, PR #631)

The biggest architectural change since launch. Nine standalone services — auth, pay, profile, registry, connections, chat, media, notify, www — consolidated into a single Next.js application: `apps/kernel/`.

- **Phase 1–4:** Scaffold → move www → move auth → move remaining 7 services. ~600 files moved, all imports rewritten
- **Phase 5:** 519 old service directories deleted. `-40,732 lines`
- **Phase 6:** ~45 cross-service HTTP calls replaced with direct function calls. `getSessionFromCookies()`, `checkAccess()`, `lookupIdentity()` — no more `fetch("http://localhost:3001/api/session")`
- **Phase 7:** 12 duplicate utility files consolidated into `src/lib/kernel/`. Shared `generateId`, CORS, rate-limit, graph membership auth
- **664 files changed, +2,362 / -40,732 lines** in a single PR

The kernel runs on one domain: `dev-jin.imajin.ai`. Caddy routes `/auth/api/*`, `/pay/api/*`, etc. to the same process. Userspace apps (events, coffee, learn, links, market, dykil) remain separate — federated apps that can be hosted anywhere.

### 🔧 Routing Fixes (17+ in one session)

Single-domain routing surfaced three classes of bugs:

1. **Client fetch paths** — bare `/api/...` needed service prefix: `/chat/api/...`
2. **Userspace basePath** — `apiFetch()` + `NEXT_PUBLIC_BASE_PATH` in `@imajin/config`
3. **Navigation paths** — `router.push()`, `href`, `window.location` all needed explicit service prefix

Also fixed: nested `<html>/<body>` in chat and media layouts (double NavBar), missing pages lost in Phase 5 cleanup, global unread count in NavBar, Caddy file_server for `/api/media/*`, auth subdomain URLs in userspace apps.

### 人 MJN Emissions — The Token Economy (#433, #641, #642)

Built in one evening. The economic loop: **gas burns MJN, attestations emit MJN, .fair defines the rates, chains record everything.**

- **Emission schedule** (`src/lib/kernel/emissions.ts`) — attestation type → MJN credits. Fixed amounts for lifecycle events, percentage-of-settlement for commerce
- **Attestation-driven handler** — after every attestation is stored, the emission schedule fires. Upserts `pay.balances`, logs `pay.transactions`. Fire-and-forget, non-fatal
- **Tiered identity emissions:** soft DID → 10 MJN ($0.10), preliminary → +100 MJN ($1.00), hard → +100 MJN ($1.00). Fully verified = 210 MJN ($2.10)
- **Valuation:** 1 MJN = 0.01 CHF (≈1¢). 100 MJN = 1 MJNx. Grounded as "one unit of compute"
- **Currency symbol: 人** — the "jin" in MJN. Person as currency. `人210` in the NavBar

Wallet display: amber MJN badge in NavBar (alongside green cash badge), BalanceCard with separate MJN/cash cards, transaction history with `人` formatting and ✨ emission icons, currency filter (All/Fiat/MJN).

**Retroactive backfill** ran on dev: 19 identities, 1,490 MJN credited across 32 emissions.

**Emissions model draft** at `docs/rfcs/drafts/emissions-model.md` — the .fair cascade applies: root .fair (protocol defaults) → identity .fair (scope overrides) → record .fair (frozen proof at attestation time = mint proof).

### 📖 Launcher & API Docs

- **Kernel services in launcher** — broke single "Kernel" tile into 9 individual services (Home 🏠, Identity 🔑, Profile 👤, Connections 🤝, Chat 💬, Wallet 💰, Media 📁, Registry 📡, Notify 🔔). New "kernel" category at top, "Userspace" label for Events/Learn/Market
- **Centered grid** — launcher tiles center instead of left-aligning
- **OpenAPI specs restored** — 8 per-service YAML specs updated for single-domain routing, `{node}.imajin.ai/{service}` server variables, new notify spec created from scratch
- **Registry docs page** — filters meta services, reads kernel specs from file instead of HTTP

### 📝 Essays

- **Essay 37:** "How to Fix the Commons" — Hardin wrong, Ostrom right, Imajin = implementation. Bridge piece for Humane Tech
- **Essay 38:** "The Inherited Pathology" — LLMs inherit "do it later" from training data. Context design as governance. SOUL.md as Ostrom's principles for an attention commons

### 📊 By the Numbers

- 72 commits on feat/kernel-merge
- 9 services → 1 kernel process
- ~45 HTTP calls → direct function calls
- 40,732 lines deleted
- 1,490 MJN emitted retroactively
- 8 OpenAPI specs updated
- 2 essays drafted

---

## April 5, 2026 — Forest Architecture Sprint (Day 64)

**8 PRs in one afternoon. 3,000+ lines. Full scoped community experience from schema to UI.**

### 🌲 Group Identities & Forests (#587–601)

The forest is the scope. Switching `X-Acting-As` changes your entire universe — events, connections, media, chat, market, pay all refract through the scope DID.

- **Group identities** (#590) — `auth.group_identities` + `auth.group_controllers`. Scope: org/community/family. Handles share namespace with personal handles
- **Forest switcher** (#591) — dropdown in NavBar, `useForests` hook, `acting-as.ts` utility. Cookie + localStorage + header pattern
- **Forest config** (#594) — `profile.forest_config` table: `enabled_services TEXT[]`, `landing_service`, `theme JSONB`, `platform_did TEXT`
- **Settings UI** (#595) — forest admin page: toggle services, set landing page, configure theme
- **OG metadata** (#596) — forest-branded social previews
- **Contextual onboarding** (#601) — `/onboard?scope=did:imajin:mooi`. Forest-branded join page. Email or client-side keypair flow. `scope.onboard` attestation on join

### 🤝 Connections Refactor (#577, #578, #579, #580)

Pods are groups now. Connections are first-class.

- `connections.connections` table — lexically-sorted DID pair PK, soft delete
- `connections.nicknames` — separate table, `(did, target)` PK
- Batch nickname resolution: `POST /api/nicknames/resolve`, `useDidNames` hook, `MemberName` component
- Chat URLs: `/conversations/did%3Aimajin%3Agroup%3Aabc` → `/conversations/group/abc`

### 🔗 Scope-Aware Services (#602)

Work order filed: 11 service issues (#603–#613). Same pattern per service: `identity.actingAs || identity.id`. Two waves: Mooi-critical first (events, connections, pay, media), then the rest.

- **12 PRs merged in one batch** — events, media, connections, pay, registry, notify, coffee, links, market, learn, chat + controller services
- Each agent run averaged 4 minutes. One import path fix.

### 📡 DFOS 0.7.0 (#535)

Deleted 924 lines of custom ingest. Library-native. 100/100 conformance on dev + prod.

### 📊 By the Numbers

- 8 PRs in one afternoon (COCOMO says 6 person-weeks)
- 3,000+ lines across 7 agent runs, avg 4 min each
- Full Mooi onboarding flow: schema → API → UI → contextual join page

---

## April 3–4, 2026 — Refund Hardening, Group Chat & Settlement Display

**Two days of plumbing. Refund flows, group membership, ledger display — the stuff that makes real commerce work.**

### 💳 Refund System Hardened (#561)

Multiple hotfixes over two days:

- **pi_ → cs_ resolution** — events stores payment intent ID, pay stores checkout session ID. Added Stripe API lookup to resolve
- **Settlement reversal** — refund route now finds settlement entries via `metadata.stripeSessionId` and reverses them (host share + platform fee). Previously only the checkout was reversed
- **Refund notification emails** — three variants: Stripe (card), e-transfer (manual), free (cancelled)

### 👥 Group Membership Management (#570, #571)

Leave/remove/add members for group chats. Toast feedback, `useDidNames`, `emitAttestation` wired. Three agent passes, clean merge.

### 📊 Ledger Display (#565, #566)

Settlement splits show as separate entries. Batch grouping with gross/net toggle shipped. Data was always correct — presentation caught up.

### 🏗 Also Shipped

- **EUDI Wallet Conformance** (#562) — scoped. MJN attestations map to W3C VCs, OpenID4VP for selective disclosure
- **ATLAS sovereign inference** (#563) — harness for Qwen3-14B, 74.6% LiveCodeBench on single GPU
- **Events invite-only gate fix** — `hasTicket` TDZ in minified bundle. Only hit authenticated users
- **Silent error handling audit** (#572) — found 38 empty `catch {}` blocks. Connections: 12, events: 10

---

## April 1–2, 2026 — Launch Party, Broadcast, & MJN Economics

**First public demo event. Zero attendance. But the broadcast system worked, the economics crystallized, and the reframe landed.**

### 🎉 Launch Party (April 1)

First real event with full infrastructure: check-in webhook → WLED bridge → LED cube responds to physical presence. Network path: Server → Cloudflare tunnel → laptop at venue → WLED on local WiFi.

Zero attendance. Distribution problem, not product problem.

### 📢 Event Host Broadcast (#552)

Markdown composer on admin dashboard. `notify.broadcast()` with event context — image banner, "Message from [Event]" header, reply-to set to organizer's email. First prod broadcast sent at 6:25 PM for 7 PM event.

### 💰 MJN/MJNx Economics Crystallized

- **MJNx** = fiat-backed stable credits (1:1 CAD). Backed by Imajin Stripe account
- **MJN** = network equity. Minted from 1.75% fee. All four parties earn MJN on every transaction
- **"Imajin is a browser" reframe** — not a platform. A browser where identity is the keypair and DFOS is the network layer. Brandon co-signed: "That is some heat."

### 🏗 Also Shipped

- **Hybrid events** (#558) — `location_type` column: physical/virtual/hybrid
- **Incremental builds** — `scripts/build-changed.sh` detects changed apps via pnpm dependency graph
- **Check-in webhook + WLED bridge** (#551) — physical presence at events

---

## March 29–30, 2026 — DFOS Identity Bridge, Federated Auth & Fee Model v2

**Every login now creates a DFOS genesis chain. Four-node relay mesh live. The economic model got its first real spec.**

### 🌐 DFOS Identity Bridge — LIVE (#532)

- **Genesis is client-side** — server never holds private keys. `@imajin/dfos` bridge wraps `createIdentityChain()` for browser
- **Lazy backfill on login** — existing users without relay chains get one silently on next login
- **Ryan's prod DID backfilled** immediately: `did:dfos:7v4vtfnh7v28ka7af3cv79`
- **Four-node mesh confirmed:** ATX / NYC / LIS peered with Imajin. Content syncing across US + Portugal
- Brandon's Go relays push to us; peer-back pending (he'll poll our `/log`)

### 📡 RFC-22: Federated Authentication

Three iterations in one session to get it right.

- **v1:** OAuth-style redirect → too complex
- **v2:** Email verification primary → but email→DID is private by design (Brandon confirmed)
- **v3 (final):** Consent-and-sign redirect. User clicks "Login with DFOS" → redirect to home platform → authenticate + consent → platform signs challenge (KMS for custodial, user key for self-sovereign) → redirect back with signed JWS → verify against chain key
- **Three tiers:** direct key auth (strongest) → consent-and-sign redirect (primary cross-platform) → email verification (fallback)

### 💰 Fee Model v2 (RFC Draft)

Three-party settlement: **1% protocol + 0.5% node + 0.25% user credit.**

- **Dual-token:** MJN (equity, earned through usage) + MJNx (stable, CHF-pegged)
- **Gas:** 100% to node, MJN-denominated, bilateral signature (relay + user)
- **Rate integrity:** decreases instant, increases require 24h notice. Rate schedule on-chain. Peering relays audit
- **Revenue streams:** settlement fees, app licensing, professional services, managed hosting, compliance certification

### 🔧 Fixes

- **Migration system fixed** — `drizzle-kit push` banned, `migrate.sh` is the only path. CI check added (`scripts/check-migrations.sh`)
- **Carmen email bug** — payment webhook had no try/catch around onboard token insert. One failure killed all subsequent emails silently. Each step now fails independently
- **RFC-21:** Imajin Conformance Suite — tests ARE the spec, ~35 assertions, 7 categories. Certification as commercial product

### 📊 By the Numbers

- 4 RFCs written or updated (19–22)
- 4-node relay mesh live
- Fee model v2 specced (three-party + dual-token)

---

## March 27–28, 2026 — Auth Redesign & the 12-PR Day

**Twenty minutes of conversation redesigned the auth model. Then agents shipped 12 PRs in one session.**

### 🔐 Auth Model Redesign

Started as "MFA screens." Became a fundamental rethink through conversation — **email is not auth.**

- **Two auth methods:** key import/paste, stored key (password-encrypted AES-256-GCM blob)
- **Three MFA gates:** email code, TOTP, SMS (future) — verification, not login
- **No password recovery.** Server can't decrypt the blob. Lost password + lost key file = lost identity. Correct sovereign outcome
- **Session duration per-device** — phone 7 days, laptop 6 months
- **Chain login removed from login page** — that's federated onboarding, not login
- Auth MFA UI shipped (PR #496, +2,754 / -653 lines)
- Three crypto bugs found in password login: base64/hex mismatch, JSON/raw parsing, PBKDF2 iteration count divergence

### 🔔 Notify Service — SHIPPED (#479)

Centralized notifications. Three phases in one day.

- **Phase 1:** `apps/notify` on port 3008/7008 (took input's slot). Schema: `notify.notifications` + `notify.preferences`. 8 templates across market, events, coffee, connections, chat
- **Phase 2:** `@imajin/notify` caller package wired into pay, events, coffee, connections, chat. Fire-and-forget like `emitAttestation`
- **Phase 3:** Notification bell + provider + toast in `@imajin/ui` NavBar
- **Input service retired** — transcribe route migrated to media, notify claimed the port

### 🏗 Also Shipped

- **QR ticket scanner** (#500) — camera scanner on admin dashboard. `html5-qrcode`, audio feedback, auto-resume, debounce
- **Attestation chain coverage** (#461) — 8 new types across 5 services: `event.created`, `ticket.purchased`, `listing.created`, `listing.purchased`, `handle.claimed`, `tip.received`, `pod.created`
- **ActionSheet** (#494) — reusable bottom sheet in `@imajin/ui`. MessageBubble: 303 → 131 lines
- **Chat @mentions** (#503) — detection, `notify.send()`, amber rendering in MessageBubble
- **Event admins consolidated** — removed `event_admins` table, consolidated on `pod_members`
- **Profile feature toggles** — migrated to single JSONB column

### 🔗 DFOS 0.6.0 — Chains Are DAGs

Brandon shipped [PR #23](https://github.com/metalabel/dfos/pull/23):

- **Chains are now DAGs**, not linear sequences. Deterministic head: `(createdAt DESC, cid DESC)[0]`
- **Ingestion statuses:** `new` | `duplicate` | `rejected`
- **Temporal guards:** reject ops >24h in future
- **Key insight from Brandon:** chains ARE CRDTs. Fork semantics are application-layer

### 📊 By the Numbers

- **12 PRs merged in one session** (March 28)
- **8 issues closed**, 4 tickets groomed
- 8 attestation types added
- 1 service retired (input), 1 service launched (notify)
- Agent performance: 12 tasks, all shipped clean. Best: 3 min (feature toggles). Biggest: 17 min (auth MFA UI)

---

## March 25–26, 2026 — Kernel/Userspace, Relay Identity & First External PR

**The architecture got its name. The relay got its identity. And someone else shipped code for the first time.**

### 🏛 RFC-19: Kernel/Userspace Architecture

Emerged from rethinking work order #274 (unified domain). Started as "should we use basePath?" → became the entire platform architecture.

- **Kernel (one app, one domain):** auth, pay, registry, connections, chat, media, profile. Infrastructure, not features
- **Userspace (federated apps):** events, market, learn, coffee, links, dykil — and any third-party app. Hosted anywhere, by anyone. Registered via cryptographic handshake
- **Shell architecture:** kernel serves toolbar/launcher, userspace apps render in sandboxed iframes
- **1% settlement fee:** 0.4% node operator, 0.4% protocol, 0.2% back to user as MJN credit
- **Agents are apps:** same registration, same compliance, same scopes. Sub-identity DIDs

### 🔗 DFOS Relay 0.5.0 — Full Conformance

- Bumped relay + protocol to 0.5.0. New `relay_operation_log` table, head tracking, async `createRelay`
- **Persistent relay identity created:** `did:dfos:z8a43zfdd4d4tz34c44tdz` ("Imajin Registry")
- Signed profile artifact with controller key
- **86/86 conformance tests** passing on dev and prod
- Brandon's "Hello, world!" artifact ingested — first external content on 0.5.0

### 👥 Chris Bennett — Second External Dev

First PR (#482) merged — chat UI cleanup, Signal-style composer. Getting local dev running exposed every friction point:

- Wrong default ports in 6 `package.json` files
- `buildUrl` producing `http://localhost:auth.imajin.ai` — localhost detection added
- `AUTH_PRIVATE_KEY` must be PKCS#8, not random bytes
- Session cookies rejected on localhost — made cookie config localhost-aware
- Chat `server.js` doesn't load `.env.local` (plain Node, not Next.js)
- **Result:** `DEVELOPER.md` overhaul with zero-to-working quickstart

### ⚡ Infrastructure

- **Power surges (×3!)** — server rebooted three times in 30 minutes. `pm2 startup` + `pm2 save` configured after first reboot — second and third auto-recovered
- **Ecosystem config overhaul** — services had drifted to stale standalone repo paths. Now 34 services (17 dev + 17 prod), all correct
- **build.sh bug** — prod builds were restarting dev processes (empty `PM2_PREFIX`). Explains multi-day deploy mystery
- **drizzle-kit .env.local fix** — silently broken on all 15 configs (only reads `.env`). Parsers added everywhere

### 🔧 Also Shipped

- **Market OG meta tags** — proper link previews with resized images, EXIF orientation fix, Content-Length headers
- **Market seller page** (#485) — `/seller/[handle]` wall of listing cards
- **`buildPublicUrl` sweep** — replaced ~30 broken URL interpolations across 13 files
- **RFC-20:** Application conformance suite — chain types extensible, DFOS owns protocol, Imajin owns projectors
- Discord links replaced with DFOS community space across 7 files

### 📊 By the Numbers

- 86/86 DFOS conformance (0.5.0)
- First external PR merged
- 34 pm2 services configured
- DEVELOPER.md: zero-to-working quickstart
- 3 power surges survived

---

## March 23–24, 2026 — Whisper, Conformance & Developer Experience

**Voice-to-text finally works end-to-end. The developer experience got its first real test.**

### 🎤 Whisper Transcription — WORKING

The full chain: record → upload → transcribe → text in composer.

- **Bug chain from hell:** MIME whitelist (audio/x-m4a missing) → Next.js RSC intercepting POST → wrong file path (UPLOAD_DIR vs storage_path) → switched to GET
- **Voice recording 0-byte bug:** dual `VoiceRecorder` instances — `onRecordingStart` triggers re-render → instance unmounts → cleanup kills recorder (8ms, 0 bytes). Fix: VoiceRecorder always stays mounted
- **Voice-to-text mode:** transcript goes into text input box, not sent as voice attachment
- Canonical `VoiceRecorder` extracted to `@imajin/input` package

### 🔗 DFOS Relay — 38/38 → 67/71 Conformance

- Bumped to `@metalabel/dfos-web-relay` 0.4.0 with countersig dedup
- Go + Rust installed on server for conformance test runner
- Brandon synced: 72 identity chains, 39 content chains, 129 ops on our relay
- CI workflow added for conformance tests

### 🛡 Agent Governance — Designed

Full sovereign agent stack mapped across 5 work orders:

- **Attestations → MFA → Agent Pairing → Delegation → Sandbox → Trust Graph → Gas**
- Agent sandbox model (#465): "kneecapped kernel" — message loop, scoped tools, memory, identity. No channel access, no filesystem, no self-configuration
- Sovereign compute thesis (#466): edge inference at $1.50-3/month vs $20/mo ChatGPT. Context embeds over time → smaller prompts → fewer tokens → cheaper

### 🛒 Market & Profile Fixes

- OG meta tags with resized images, EXIF auto-orient, Content-Length headers
- `resolveMediaRef` size presets in `@imajin/media` (thumbnail/card/detail/og/original)
- `.fair` access field: now handles both string `"public"` and object `{type: "public"}`
- Profile events on profile page (#487)

### 💬 Chat Fixes

- `conversation_members` added to list query — Chris couldn't see OG group
- Dead `chat.participants` v1 reference removed from auth access
- Mark-as-read implemented (was never wired up)
- DM members backfilled for all existing DMs (63 rows)

### 🧠 Memory Restructured

- `MEMORY.md` trimmed from 55KB to 6.6KB (curated highlights)
- 6 context files created: chat, dfos, events, identity, infrastructure, pitch
- Full archive at `memory/MEMORY-archive-2026-03-23.md`

### 📊 By the Numbers

- Whisper transcription: end-to-end working
- 38/38 DFOS conformance (0.4.0)
- 5 agent governance work orders mapped
- 63 DM member rows backfilled
- 43 survey responses matched to tickets

---

## March 20–22, 2026 — Chain-Backed Identity, DFOS Relay & P26 Epic

**Three days, one thesis: every identity operation gets cryptographic proof underneath.**

### 🔗 DFOS Relay — LIVE (PR #453)

- **Registry IS the relay.** Mounted `@metalabel/dfos-web-relay` v0.3.0 inside registry at `/relay/*`
- PostgresRelayStore backed by drizzle — relay data lives in the same DB as node registrations
- Same DID, same service, same trust boundary
- Live at `dev-registry.imajin.ai/relay/`
- AuthZ gating tracked in #454 (require verified DID for writes before prod)

### 🧪 Auth Test Suite — SHIPPED (PR #451, #408)

- 43 integration tests covering the full auth surface
- `imajin_test` DB created for isolated test runs
- CI wired — safety net for all future auth changes

### 🏗 P26 Epic: Unified Identity Substrate (#415–#425)

**Core thesis adopted from Greg (Tonalith):** DFOS is not an external protocol — it's the cryptographic substrate MJN's identity layer rests on. One DID, not two. `did:imajin` is an alias (like DNS), chain is canonical.

**Batch 0 — Auth Consolidation (PR #437)**
- 4 services migrated from manual session validation to `@imajin/auth` + dfos-protocol 0.2.0
- connections, input, www, pay all use `requireAuth` now

**Batch 1 — Foundation (PR #440)**
- #417: `chainVerified` added to Identity type + session + profile badge
- #420: Door-check attestations — `institution.verified` + `event.attendance` emitted on check-in

**Batch 2 — Trust Boundaries (PRs #441–#443)**
- #416: Chain-verified node registration + DID resolution in registry
- #418: Portable .fair attribution with chain-backed creator proof
- #419: Chain-verified settlement parties in pay

**Batch 3 — Federation (PRs #444–#447)**
- #421: Chain-recorded pod membership attestations in connections
- #422: Signed messages with chain keys in chat (+ migration for signature column)
- #423: Enrollment and completion attestations in learn
- #424: Chain presentation endpoint + login UI + chain provider abstraction for external onboarding

### 🔐 Auth Rebuild Design (#395)

- **Self-certifying identity** — every `did:imajin` backed by a DFOS proof chain, verifiable without our server
- **Key rotation** — signed handoff via chain updates (previously: no mechanism at all)
- **Multifactor key roles** — auth/assert/controller keys on separate devices with different compromise boundaries
- **Bilateral attestations** — DFOS countersignatures replace our single-signature model
- **First test suite** — verification tests proving every bridge linkage is correct

Same Ed25519 curve, byte-compatible keys. One keypair, two DIDs. Nothing existing breaks.

### 💬 Chat v2 Migration (PR #436, #435)

- Migrated v1 conversations to v2 schema and removed v1 tables
- Event name resolution for auto-created conversations
- Drizzle migration re-baseline with v2 tables (#428)

### 🔑 DFOS Sprint (PR #434, #431)

- Keys-first login flow with stored key auto-login
- Unified email-first login page (#427)
- Gas fee adjustment (0.001 → 0.01 MJN)
- Nav bar balance fix (reads `data.total` not `data.amount`)
- Profile email renamed to `contact_email` (auth owns identity email)
- Essay 31: "The Receipt" — chain-native token launch from usage proof

### 🛒 Market Fixes

- Image upload via media service instead of data URLs (#429)
- Seller name resolved from auth lookup (#430)
- Media URL fix (use service prefix, not hardcoded prod)
- Image dedup by hash on upload

### 📄 Documentation

- Developer guide updated — stable DIDs, attestations, DFOS, market, 15 services
- RFC-18: Media Revocation & Cross-Graph Attribution
- Build timeline phases 10–12 updated
- Work orders written for Batch 2 + 3
- Completed work orders archived

### 📊 By the Numbers

- 10 P26 issues implemented (#416–#425)
- 12+ PRs merged
- 43 auth tests
- DFOS relay live
- **Services: 15** — all with chain-aware identity

---

## March 18–20, 2026 — Market Launch, Places & DFOS Partnership

### 🛒 Market — SHIPPED

- **6 deploy bugs fixed** in one session (3 parallel agents): getSession() API mismatch, missing Create Listing CTA, CA$NaN price (Postgres returns strings for numeric), raw DID → resolved seller names, image array filtering, market missing from health check + homepage + launcher
- PRs #388–391 merged, issues #373 + #382–387 closed

### 🍞 Toast Component — SHIPPED

- `ToastProvider` + `useToast()` in `@imajin/ui`
- Replaced ALL 48 `alert()` calls across 9 apps (dykil 17, links 9, events 8, connections 4, learn 4, www 3, pay 2, coffee 1)
- PR #391 merged

### 🔧 CI Fixed

- Root cause: `apps/market/.eslintrc.json` missing → `next lint` prompted interactively in CI → hung. One-file fix. CI fully green.

### 📍 Places App — DESIGNED (#392)

- Local business discovery, check-ins, business profiles
- Two doors: customer stubs (check in → soft business profile) vs owner claim/create (review queue)
- Bilateral featuring model — each side independently controls what shows on their profile
- Connection types: founder (non-severable), admin, employee, regular, supporter
- Port 3105/7105

### 🤝 DFOS × Imajin — Layer 6

**The big move.** Created Discussion #393 — a 30K+ word technical deep dive mapping DFOS's proof substrate against Imajin's application layer.

**The concept:** DFOS is L0–L5 (crypto core → identity chains → content chains → beacons → web relay → application). Imajin is **Layer 6** — settlement, trust graph, .fair attribution, sovereign presence. *Localized internet infrastructure.*

**Protocol comparison findings:**
- Identical Ed25519 curve (`@noble/ed25519`), byte-compatible keys
- DFOS: self-certifying DIDs (chain-derived), JWS signatures, dag-cbor canonicalization, CID content addressing
- Imajin: random DIDs (nanoid), hex signatures, JSON canonicalization, SHA-256 hashes
- DFOS has key rotation, countersignatures, Merkle beacons — we don't (yet)
- We have settlement, trust graph, presence, commerce — they don't

**Three integration doors:**
1. **DID Bridge** ✅ — same keypair derives DFOS chain. Actionable now.
2. **Sideloading** ✅ — two paths: relay (proof gossip, spec coming) + MCP (OAuth 2.1, 20+ tools, live now)
3. **Provisioning** 🟡 — needs DFOS space creation API

**The symbiosis:** DFOS content chains feed Imajin presence context. Your writing becomes searchable, verifiable, consent-gated knowledge — settled via gas fees that flow back to content sources. Neither stack does this alone.

**Brandon (Clearbyte, lead DFOS dev) responded:** "very very interesting" / "sounds like things line up nicely" / "excited to jam w you on this!" — sending updated web relay spec + TS implementation.

**Agent identity (#394):** Sub-identities with VC delegation. Imajin types every signed message as `human`, `agent`, or `device`. DFOS independently arriving at same pattern.

### 📊 By the Numbers

- 7 issues closed (#373, #382–387)
- 4 PRs merged (#388–391)
- 2 issues created (#392, #394)
- 1 discussion created (#393 — 30K+ words)
- CI fixed
- 48 alert() calls eliminated
- **Services now at 15:** auth, pay, www, profile, registry, events, chat, connections, input, media, coffee, dykil, links, learn, market

---

## March 15–17, 2026 — Stripe Connect, Voice Fix & Infrastructure

### 💳 Stripe Connect — SHIPPED

- **PR #360 merged** — Multi-seller payouts. Auto-resolves seller DID → connected account, calculates platform fee. Schema, types, fee constants.
- **PR #361 merged** — Connect onboarding UI + payout management page. Sellers onboard to Stripe Express in 5 minutes.
- **PR #362 merged** — PayoutSetupBanner in events + coffee dashboards. Prompts sellers to connect.
- **PR #359 closed** — Connect onboarding UI complete.
- **#62 closed** — EMT checkout flow complete (selection, instructions, 72h hold, admin confirmation all working).

### 🎤 Voice Recorder — FIXED

- Root cause found: commit `867d10f` (March 5) added hold-to-record pointer events that conflicted with click-to-toggle. `pointerdown` → `pointerup` fired within milliseconds = 0-byte blob.
- Fix: removed all pointer events, reverted to simple click-to-start/click-to-stop. 46 lines deleted.

### 📋 Issues & Architecture

- **#281 updated** — EMT organizer config: toggle, auto-fill from profile email, buyer disclaimer
- **#363 created** — Escrow service for EMT platform fees, buyer protection, marketplace settlement. Trust-graph-dynamic escrow requirements.
- **#358** — Per-ticket attendee registration (specced, not yet built)
- **RFC-14 updated** — "Prior Art: Protocol-Level Redistribution" section. Zakat, waqf, potlatch, tithe — 1,400 years of protocol-level redistribution as precedent for MJN fee model.

### 🖼 Media Service — SHIPPED

- **PR #353** — Media browser UX: multi-select, three view modes, sort persistence, color-coded .fair badges, batch actions
- **PR #354** — Media inference tools: `searchAssets` + `readAsset` in `@imajin/llm`, internal API key auth, wired into sovereign inference
- **PR #355** — RFC consolidation: all 16 RFCs canonical in `docs/rfcs/`, INDEX.md, stubs for RFC-03 + RFC-04

### 🏗 Infrastructure

- **Postgres backups live** (#357) — hourly `pg_dump` of 3 prod DBs, 30-day local + 90-day Synology NAS retention
- **GPU node fan fix** — `fancontrol` crashed after reboot (hwmon paths shifted). Updated config, service running.
- **GPU node IP** — moved from WiFi (192.168.1.124) to ethernet (192.168.1.234)
- **Git history cleaned** — squashed 40+ duplicate commits from Greg's PR #356 into single commit via rebase + force push
- **Build log parser fix** — en-dashes in date ranges no longer break heading parser

### 🧠 CRDTs — NEW DIRECTION

- CRDTs identified as the path for federated node synchronization
- Entry point: registry sync, then expand to full mesh — attestations, trust graph, profiles converge without central coordinator

### 📊 By the Numbers

- 5 PRs merged
- 3 issues closed, 2 created
- 40+ garbage commits squashed to 1

## March 14, 2026 — Settlement Fixes, Sovereign Commerce & Building in Public

### 🧠 Sovereign Inference — Live

- **"Ask Me" presence** — profile owners enable AI trained on their context. Trust-bound access, inference fees, streaming responses
- **`@imajin/llm` package** — Vercel AI SDK wrapper with cost tracking + provider factory
- **Presence bootstrap** — enabling inference auto-seeds `.imajin/` folder in media (soul.md, context.md, config.json)
- **Trust distance engine** — connections service computes BFS trust distance (direct, friend-of-friend, stranger)
- **6 trust-scoped tools** — events, connections, attestations, profile, pay, learn — each scoped to conversation participants
- **PresenceChat UI** — streaming modal chat on profile pages
- **Cost settlement** — 80% owner / 20% platform via .fair

### 💰 Settlement Pipeline — Fixed

- **Critical: settlement field mismatch** — `settleTicketPurchase` was reading `fairManifest.attribution` but manifests use `distributions`. Every ticket settlement silently skipped since day one.
- **Critical: confirmation emails broken** — Date serialization bug crashed webhook after ticket creation. 66 tickets across 2 events never got emails. Backfill script written.
- **Coffee tips never settled** — webhook marked tips completed but never called `/api/settle`. Wired up .fair splits (98.5% creator, 1.5% platform).
- **Tip notification emails** — recipient gets "☕ you got a tip!", sender gets "🧡 thanks for tipping". Pay webhook now forwards all metadata.

### 💳 Pay Dashboard — Shipped

- Payment history with paginated transactions, service/date filters, expandable .fair attribution chains
- BalanceCard component — cash vs credit bucket display
- Platform fee verification confirmed correct
- Dashboard replaced static API docs with authenticated balance + recent transactions

### 🔐 Onboard Token Hardening

- Corporate email scanners (Outlook Safe Links) consuming verification tokens before humans clicked
- 60-second grace window for scanner-consumed tokens
- Graceful redirect for users with existing sessions

### 🏗 Build Pipeline

- `transpilePackages` added to all 14 apps for `@imajin/*` workspace packages
- Next.js type checking delegated to tsc (pnpm symlinks confuse Next's checker)
- All `.env.example` files updated, 12+ missing prod env vars set
- Fixed malformed `next.config.js` in chat, dykil, input (closing brace on wrong line)

### 🏛 Architecture Sessions

- **Profile scopes** (#346) — profiles gain scope field: actor, family, community, org. Businesses are org-scoped profiles. Foundational for everything below.
- **Check-ins reimagined** (#246) — not a separate service. A check-in is an attestation of presence with any entity in your graph. "I checked in at Pilot Coffee" = "I checked in on Carl." Same operation.
- **Market** (#56) — renamed from shop. Consent-based local commerce. No feed, no infinite scroll. Two modes: active browsing + mailbox delivery.
- **Attention marketplace** (#114) — engagement attestation chain: delivered → opened → engaged → converted. Emergent pricing tiers. Unopened deliveries get ~80% refunded as credit. Conversion tracking on-platform vs off-platform.

### 📄 Public Build Log

- `/build` page on imajin.ai — this file. Single markdown, newest first.
- Footer build version now links to `/build` across all services.
- Published two new essays (#18, #19)

### 📊 By the Numbers

- 40+ commits to main
- 4 issues closed (#141, #143, #335, #337)
- 3 new issues created (#345, #346, #347)
- 97K LOC, $1.92M COCOMO estimate, 32× multiplier vs actual spend

---

## March 12–14, 2026 — 48-Hour Sprint: Attestation Layer, Settlement & Sovereign Inference

*~60 commits · 12 PRs merged · 11 issues closed · 7 new issues created*

### 🔐 Three-Phase Sovereign Stack Hardening

**Phase 0s — All Three Layers (merged)**
- Identity: three-tier model (soft → preliminary → established), fail-open defaults fixed
- .fair: schema hardening, templates (ticket/media/course/document), conversation access type
- Settlement: ticket settlement wired through pay with platform fee

**Phase 1s — All Three Layers (merged)**
- .fair cryptographic signing — Ed25519 manifest signatures via `@imajin/fair`
- Attestation data layer — `auth.attestations` table, ingestion, DID→pubkey resolution
- Settlement verification — real Ed25519 .fair signature verification

### 📜 Attestation Infrastructure — Zero to Six Types

Built the entire system and wired emitters into three services:
- `transaction.settled` + `customer` (pay)
- `connection.invited` + `connection.accepted` + `vouch` (connections)
- `session.created` with auth strength metadata (auth — all 4 login flows)

Pattern is portable: ~20 lines per new emitter.

### 🧠 Sovereign Inference Engine — 7 Tickets in One Session

Full "Ask [Name]" presence stack from zero to streaming UI:
- `.imajin/` folder bootstrap — auto-seeds on registration
- `@imajin/llm` package — Vercel AI SDK + cost tracking + provider factory
- Trust distance endpoint (BFS on connections graph)
- 6 trust-scoped tool files (events, connections, attestations, profile, pay, learn)
- SSE streaming query endpoints on profile
- Cost settlement: 80% owner / 20% platform via .fair
- PresenceChat UI — modal chat on profile pages

Key design: Tools injected by trust distance. Distance ≤1 gets social graph. Self-query gets everything. Every tool scoped to two participants — presence can't fish.

### 💡 Attention Marketplace Concept

Imajin's answer to advertising. You're the vendor, not the product. Businesses query the attestation graph to find opted-in humans, pay MJN per result, users get micro-payments. Consent via attestations, not a central DB.

Academically validated by a 2025 Springer philosophy paper proving the current attention market is ethically broken — every problem they identify, the AttMart solves.

### 💬 Real-Time Chat

- WebSocket deferred auth, real-time delete + reactions
- DID name resolution, group membership via pods
- Modern composer, scroll pinning, legacy media compat

### 📋 Roadmaps + Strategy

- Three hardening roadmaps (.fair, Identity, Settlement)
- Fee model: 0.75% capped micro-investment
- Platform utility doc — "every intermediary becomes obsolete"
- Protocol matrix live on landing page (22%)
- Whitepaper v0.3 with Greg's architectural review

### 🔧 Also Shipped

- Dead wood audit (8 dead tables identified)
- Local dev env files, check-env.ts validation
- CORS + auth unification across all services
- Media manager: rename, move, delete, .fair editor polish
- Health endpoints on all 13 services
- CSS progress bar fixes on landing page

### 📊 Numbers

- ~60 commits
- 12 PRs merged
- 11 issues closed
- 7 new issues created
- $25 avg cost per PR — 167 PRs for $4K total inference
- ~1,200 lines for sovereign inference alone

---

## March 9–12, 2026 — Chat DID Rewrite, Whitepaper & Infrastructure

*82 commits · 31 issues closed · deployed to dev + prod*

### 💬 Chat: DID-Based Rewrite (#278, #275, #276, #280, #283-288) — SHIPPED TO PROD

- Complete architecture overhaul: conversations keyed by deterministic DIDs instead of DB IDs
- New v2 schema: conversations, messages, reactions, read receipts
- `@imajin/chat` shared package — one `<Chat did="..." />` component powers chat.imajin.ai AND event lobbies
- WebSocket subscriptions per-conversation with auth
- Group messaging: create groups, search/filter contacts, compose to multiple people
- Composer extracted: voice recording, file upload, location sharing, emoji — all shared
- Legacy pods, surrogate keys, and old chat tables deprecated
- 12 bug fixes: message alignment, link preview cards, cross-origin cookies, iOS overflow, React key collisions, duplicate contacts, textarea auto-resize

### 📄 Whitepaper v0.3 — LIVE AT imajin.ai/whitepaper

- Major rewrite around 4 identity scopes (Actor, Family, Community, Business) × 5 primitives (Attestation, Communication, Attribution, Settlement, Discovery)
- Integrated 8 architectural review documents from Greg Mulholland: cryptographic attestation layer, .fair signing, exit credentials, progressive trust, Org DID vetting, gas model ceiling, declaration granularity
- Consent folded into Attribution and Attestation — no longer a standalone primitive
- New `/whitepaper` page on imajin.ai rendering the markdown directly

### 📋 MJN Protocol Repo — PUSHED

- RFC-0001 (Core Spec) rewritten: 5 primitives, typed identity graph, actor subtypes
- RFC-0002 (did:mjn Method) updated: typed DIDs with scope in DID Document
- README updated with scopes × primitives matrix

### 📚 Learn + Pitch Deck — SHIPPED

- Interactive primitive matrix component for slide rendering
- Markdown tables + list grouping in lesson renderer
- Course types: decks auto-present on enrollment (no click-through)
- Students dashboard: enrolled users with names, emails, progress tracking

### ⚙️ Platform Infrastructure — SHIPPED

- `@imajin/config`: shared service manifest, session cookie config, CORS (#227, #270)
- `build.sh`: unified script with --dev/--prod, replaces build-dev.sh
- `check-env`: validation runs before every build, catches missing vars (#191)
- Session cookies scoped by environment (dev/prod no longer collide)
- FixReady + Karaoke removed from service manifest — plugin architecture (#249)

### 🔄 Refactors — SHIPPED

- Self-fetching pages → direct DB queries across coffee, profile, events (#190)
- `@imajin/chat` extracted as shared package from duplicated components (#196)
- Events magic-link flow migrated to `@imajin/onboard` (#225)

### 🛠 Other Features

- Privacy page + footer link across all services
- Optional email/phone collection at registration
- Coffee service notified on checkout.completed (#154)
- Inline question editing in dykil survey builder
- Bug reporter: upload context, paste support, auto-folder assignment
- README repositioned as MJN reference implementation with protocol matrix

---

## March 6–9, 2026 — Security, Learn, App Launcher & Onboarding

### 🔒 Security Hardening (#179) — SHIPPED TO PROD

- Rate limiting on 11 endpoints across 5 services
- Webhook idempotency (pay + events deduplication)
- Auth added to previously public endpoint
- Checkout amount validation (min/max/quantity bounds)

### 🐛 Bug Reporter (#243) — SHIPPED TO PROD

- In-app floating 🐛 button for logged-in users
- Report types: Bug, Suggestion, Question, Other
- Screenshot upload, admin triage panel
- One-click GitHub issue import with labels
- Fixed: auth URL misconfiguration hiding the button on prod

### 🏥 Service Consistency (#242) — LIVE ON DEV

- 12 health endpoints added (all services now have `/health`)
- CORS standardized across auth endpoints
- Error messages sanitized (19 endpoints no longer leak internals)

### 📚 Learn App — SHIPPED

- Full course platform: courses, modules, lessons, enrollment, progress tracking
- Slide presentation system for pitch decks
- Linked courses ↔️ events (live workshop banners)

### 🚀 App Launcher — SHIPPED

- Registry-driven navigation across all services
- Tier-filtered: soft DIDs see public apps, hard DIDs see everything
- `/apps` page with full service directory

### 🔗 Onboarding System — SHIPPED

- `@imajin/onboard` shared package — email → soft DID flow
- Works from any service (learn, events, etc.)
- Same email always produces the same DID

### 📊 Platform Health Page — SHIPPED

- All 14 services visible at a glance
- Auto-checks health endpoints

### 💰 E-Transfer Fix — SHIPPED TO PROD

- Unauthenticated users can now complete e-transfer checkout
- Email/name fallback creates soft DID (matches Stripe flow)

### 🧹 Nav & UX Polish

- Connections + chat removed from launcher flydown (cleaner)
- 🐛 Report a Bug added to profile dropdown
- 💬 Messages icon with unread badge + 🤝 Connections shortcut in shared nav
- QR code fullscreen overlay for invite links
- Accepted invites now show linked profile names
- Chat: fixed own messages counting as unread
- Chat: organizers can access event chat without a ticket
- Chat: auto-scroll only on new messages, not every poll

### 📝 Content & Docs

- RFC discussion link added to imajin.ai landing page
- Trust-gated service layer framing on homepage + README
- sitemap.xml + llms.txt added
- Build timeline + cost estimates updated (739 files, 68k LOC)
- Stream 2 revised: "Sovereign Ad Routing" → "Declared-Intent Marketplace" with signal strength model
- Pitch deck v2 updated for AgentCon + $1M raise framing

### 📋 Issues Groomed

- #244 — Delegated App Sessions
- #246 — Check-ins (Foursquare-style location presence)
- #250 — Media context routing (per-app upload scoping)
- #256 — Epic: Sovereign Inference (API gateway + presence bootstrap)
- #258 — Presence Bootstrap (.imajin folder)
- #259 — Epic: Node Operations (admin dashboard, monitoring, event bus)
- #260 — Notification system

### 📢 RFCs Moved to GitHub Discussions

- #252 — Cultural DID (collectives, scenes, communities)
- #253 — Org DID (businesses, legal entities)
- #254 — Plugin Architecture + Bounty model
- #255 — Sovereign User Data (portable identity bundles)

### 🌐 Community

- Connected with Dark Forest OS (dfos.city) — strong philosophical alignment

---

## March 5–6, 2026 — Media Service Complete & Auth Bug Squashing

### Shipped ✅

- **Media service complete** (#177) — 7 child tickets, `@imajin/fair` shared package, full upload/delivery/folders/classification/UI
- **Auth tier resolution bug** — fixed magic link always minting soft JWTs even for hard DID users
- **Login consolidation** (#207, PR #208) — auth.imajin.ai is canonical, killed profile login, 264+/391-
- **Nav-bar login loop fix** — all apps now go directly to auth, bypassing profile redirect
- **Auth stale localStorage fix** — validates session cookie before trusting localStorage
- **Shared `isEventOrganizer()`** (#210) — replaced inline auth in 8 API routes
- **Survey gate for tickets** (#211) — require survey completion before purchase
- **Survey pre-fill on reload** — 3-tier auth (session → localStorage → DID)
- **Invite-only events** visible to cohosts/ticket holders with badges
- **postMessage origin fix** + server-side visibleIf validation
- **HTML links in survey questions** — allowlisted safe tags
- **Ticket tier reordering** — up/down buttons + sort_order column
- **PATTERNS.md** — 305 lines of canonical code patterns
- **Ollama on imajin-ml** — qwen2.5-coder:7b + nomic-embed-text running
- **Cost estimate updated** — 697 files, 63.5k LOC, $874k traditional vs $37k actual

### 📊 Key Numbers

- +15,733 lines of code in 2 days
- +148 files
- ~$576 in API spend (vs $819 for the first 13 days)
- ~25 commits to main

### 📝 Lessons Learned

- Reactive feature-chasing burns 3x more tokens than deliberate architecture
- Always check the parent component when debugging iframe visibility
- SurveyJS models in "completed" state won't render — need fresh instances
- "Does anyone need this?" should be asked before building, not after

---

## March 4–5, 2026 — GPU Node, Media Service, Input & .fair Attribution

### 🖥 GPU Node — imajin-ml

- Stood up RTX 3080 Ti compute node at 192.168.1.124
- Ubuntu 24.04, NVIDIA drivers + CUDA
- faster-whisper large-v3 running on GPU — 10x real-time transcription
- FastAPI service on port 8090
- Fan control configured — idle noise dropped ~70%
- **First human voice transcribed on sovereign hardware**

### 🎫 Ticket Purchase Happy Path Fixed (#98)

- 4 bugs found and squashed in the checkout→payment→webhook→ticket chain
- Missing schema prefixes, missing metadata fields
- Full flow verified end-to-end with live Stripe

### 📧 Email Rebrand

- Dark theme ticket confirmation emails
- QR codes on tickets (encode ticket ID for check-in scanning)
- IMAJIN wordmark footer, Discord + GitHub links
- Brand constants locked in `@imajin/ui` (BRAND)

### ⚖️ .fair Attribution System

- Auto-generates .fair manifests on event creation
- Records .fair on pay transactions
- Two-level architecture: event splits (organizer vs platform) + distributions (contributors within event)
- Platform DID registered (1.5% fee)
- .fair viewer in event editor + public-facing accordion on event page
- "Who gets paid when you buy a ticket" — fully transparent

### 📊 QR Codes on Event Page

- Ticket cards show QR codes (3-column layout)
- Email + page QR codes both encode ticket ID

### 💰 cost-estimate Tool Published

- `ima-jin/cost-estimate` — public Python tool analyzing git repos for build cost
- Imajin monorepo: $629K traditional estimate, $20.8K actual (30x cheaper)

### 📢 Essay Published

- Essay 08: "The Ticket Is the Trust" posted on imajin.ai

### 🎤 Input Service (#166–172)

- `apps/input/` — universal input gateway at input.imajin.ai
- Port 3008/7008
- Telegram-style input with voice transcription + telemetry

### 📦 Media Service — Complete (#177, 7 child tickets)

~4,800 lines, ~$7 agent cost, ~90 min wall time

| Ticket | What | Lines |
|--------|------|-------|
| #185 | `@imajin/fair` shared package (types, validator, FairEditor, FairAccordion) | +749 |
| #181 | Media scaffold + DID-pegged upload (SHA-256, .fair sidecar) | +538 |
| #182 | Authenticated delivery (.fair access control, thumbnails, ETag) | +268 |
| #175 | Events app migrated to shared `@imajin/fair` package | -946 net |
| #187 | Virtual folder system (DB schema, CRUD API, FolderTree component) | +723 |
| #186 | Heuristic ML classifier (mime/EXIF/filename stub, same API as future CLIP) | +324 |
| #183 | Three-panel media manager UI (upload, browse, preview, .fair editor) | +1,042 |

### 📋 API Specs (#138 Phase 1 + 2)

- ~5,650 lines OpenAPI 3.1 YAML spec for all 11 services
- Re-runnable generation script (`pnpm run generate:api-specs`)
- `/api/spec` endpoint on every service
- Registry aggregator at `/api/specs` + proxy at `/api/specs/[service]`

### 🔧 Infrastructure

- Port convention standardized — core 3000+/7000+, imajin apps 3100+/7100+, client 3400+/7400+
- Prod + dev .env.local audit — all PORT values + service URLs corrected
- Self-fetch bug found — coffee + links 404'd from wrong port defaults. Patched with env vars.
- 5 build fixes on agent-generated code (type narrowing, Buffer types, duplicate directories, Map iteration)

### 📋 Issues Created

- #165–172 (input service family)
- #173 (email rebrand)
- #174 (platform .fair trust)
- #175 (events .fair editor)
- #176 (version in footer)
- #177–187 (media service family)
- #189 (CLIP on GPU node)
- #190 (self-fetch refactor)
- #191 (env config standardization)

### 🏗 Architecture Decisions

- Own data → DB direct, other service data → HTTP API
- Platform DID hardcoded in build (fork = different platform)
- .fair version = spec version
- Heuristic classifier as stub, same contract as future CLIP
- Event DID holds the pot, distributions say who gets what inside
- Always build-check agent branches before merging

### 📊 By the Numbers

~64 commits, ~11,000+ lines of code, 3 new services (input, media, GPU transcription), 11 API specs, 20+ issues created/closed, and the ticket purchase flow works end-to-end. All in about 30 hours.

---

## March 3–4, 2026 — Pay Engine, Profile Apps & Dashboard Polish

### 🏗 Major Features

**Pay Service**
- #143 — Two-bucket balance model: cash (real money) vs credits (house money). Credits burn first, earnings go to cash. Gift and event-topup endpoints.
- #142 — Stripe Connect + recurring webhooks: Express onboarding for connected accounts, charge routing to creators, subscription lifecycle handlers, cash withdrawal endpoint.
- #154 — Coffee→Pay routing: Removed coffee's independent Stripe integration. All payments route through pay. Single payment pipeline.
- Cross-service session auth + balance endpoint
- Transaction ledger, balance system, settlement engine, balance badge
- Wallet balance in nav bar for logged-in users

**Profile Service**
- #152 — Follow system: `profile.follows` table, follow/unfollow API, status check, counts, optimistic FollowButton component
- "Ask [Name] (coming soon)" placeholder — Network of Souls preview
- Links from links service displayed on profile pages
- Incognito mode for profiles (visibility field)
- Identity tier detection + upgrade messaging fix

**WWW (imajin.ai)**
- Landing page redesign: IMAJIN wordmark → "The internet that pays you back" → 5-column live stats grid (Servers, Presences, Humans, Businesses, Lightning)
- Stats pulled from `profile.profiles` schema at build time

**Events**
- #145 — Dynamic survey names on event pages
- Survey visibility + paywall options on event editor
- Event PUT API fix (metadata/survey settings were silently dropped)
- Timezone drift fix in event editor
- Dykil embed shows without nav chrome, surveys gate on first question

**Coffee**
- Configurable fund directions — supporters choose where money goes
- Setup/edit page, dashboard, nav integration, landing CTA
- Avatar rendering fix (handles relative URL paths)
- Layout overhaul — removed constrained white card wrapper

**Links**
- #135 — Complete UI, per-link visibility, deploy to dev
- Renamed to "My Links" with Go to Stats + Edit Theme buttons
- Auto-creates from profile data on first visit

### 🧹 Platform / Infra

- #144 — Postgres schema isolation per service (chat, events raw SQL updated)
- #146 — Normalized footers and app landing pages
- #147 — Standardized dashboard flows across dykil, coffee, links
- #149 — Fix reset script
- Updated all 11 `.env.example` files
- Drizzle `tablesFilter` added to coffee + links configs (prevent data loss)
- RFC-05 drafted: intent-bearing transactions and contribution pools

### 📝 ZERR Integration

- Reviewed Steven Sobo's 3 spec documents
- Rewrote #139 and #140 to reflect actual architecture (filesystem, not SQLite)
- Created #153 for keypair exchange model
- Architecture decision: direct API integration at werai.ca, no wrapper

### 📋 Issues Closed: 7+

#135 #144 #145 #146 #147 #152 #154 (plus #142 and #143 merged)

### 📋 Issues Created: 4

- #150 — www: revalidate landing page stats (ISR)
- #151 — profile: incognito mode filtering in search/listings
- #152 — profile: public profile page (follow, bio, trust indicators)
- #153 — ZERR keypair exchange (E2EE trust relationship)

### 🚀 Deployed

Dev + Prod: www, pay, coffee, profile

---

## March 2, 2026 — Events, Dykil & First External Contributions

### 🎟 Events & Tickets

- Hard DID ticket purchase flow — logged-in users get tickets under their real DID, not a throwaway soft DID
- Email attachment — Stripe checkout email auto-attaches to your profile if missing
- Soft → Hard DID migration — tickets and chat history follow you when you log in later
- Auto-join both chats — ticket buyers added to group chat AND lobby (#97)
- My Tickets / Buy tabs — ticket holders see their tickets, everyone else sees buy flow (#103)
- Stripe name in nav + chat — soft DID users show their real name (#104)
- Chat accordion scroll fix — no more page jump (#105)
- Ticket tier editing — full edit UI for tiers, perks, prices. Append-only after sales
- Price display — proper $X.XX format
- Event page caching — revalidate=60 + instant cache busting on save
- Success page — event CTA + link back after purchase
- Email footer update — "You just transacted on the sovereign network"

### 💬 Chat

- `/api/participants/migrate` — migrates all chat data between DIDs with PK conflict handling

### 📊 Dykil (Sovereign Surveys)

- Full rebuild — SurveyJS renderer, custom form builder, results dashboard (#124, #125, #127)
- Events integration — survey picker in event editor, embed page, accordion on event page (#126, #129)
- Multi-page survey support — fixed all renderers to handle `pages[]` format
- "Don't You Know I'm Local?" Business Survey — 20 questions across 7 pages: business type, ad spend, platform costs, customer communication, trust & community
- Personal Edition Survey — 20 questions: internet/phone costs, streaming & subscriptions, data privacy, platform dependency, community trust
- Contact capture — both surveys end with optional email/name collection
- Deployed to dev — dev-dykil.imajin.ai live on port 3012

### ✉️ Email

- SendGrid integration — replaced nodemailer/SMTP with SendGrid REST API, zero dependencies (#100)

### 🧭 Navigation

- Surveys + Links added to nav — all apps now show Home, Events, Surveys, Links
- Dashboard share URL fixed — correct `/:handle/:surveyId` path

### 👥 External Contributions (Josh Allen, Staff SWE @ Slack)

- PR #119 — Developer guide for macOS local setup
- PR #120 — Localhost support (CORS, cookie domain, invite gate toggle, port fixes)
- PR #121 — Lint fixes
- PR #130 — Stripe API version configurable, missing subscription statuses
- PR #131 — Lockfile update for dykil deps
- PR #132 — Event creation redirect fix
- PR #133 — Gitignore next-env.d.ts
- PR #134 — Draft events visible to creators with badge
- PR #118 — Changes requested (Claude settings should stay local)

### 📋 Issues Filed

- #136 — Conditional logic UI for form builder (visibleIf)
- #137 — AI survey builder — first .fair revenue accumulator POC
- #138 — Comprehensive OpenAPI spec across all services

### 📝 Documentation

- Month 1 Summary committed
- Dykil PROJECT.md — full vision document

### 🔧 Infrastructure

- Branch protection active — core team bypass, external contributors must PR
- Stale dykil rebuild branch cleaned up
- Dev dykil running on pm2 with Caddy routing

---

## March 1, 2026 — v0.3.0 Launch Party Infrastructure

### Chat & Events merged into monorepo

Chat and Events apps ported from standalone repos into the main monorepo, shared packages, unified deploy pipeline.

### 10 chat features built in one swarm session

- ✅ Unread message counters with badge indicators
- ✅ Typing indicators + online/offline presence
- ✅ Emoji reactions on messages
- ✅ Link previews via server-side unfurling
- ✅ Message actions — reply, edit, delete
- ✅ Image & file sharing with upload
- ✅ Identity tiers + soft DID session support
- ✅ Trust graph invite system
- ✅ Event lobby chat (server-mediated, open to all ticket holders)
- ✅ Permission middleware — identity-tier-based access control

### Ticket purchase flow — end to end

Stripe checkout → pay webhook → events webhook → soft DID created → ticket record → buyer auto-added to event lobby chat

### Event page upgrades

- Lobby chat accordion (inline on event page, collapsed with unread badge)
- Edit button for event creators
- Organizer name resolved from DID via auth lookup
- Nav dropdown z-index fix over hero images

### Magic link authentication

Buy ticket → get email with magic link → click → logged in → see lobby → chat. No registration required.

### Cross-service CORS

Events page can now embed chat and auth calls cross-origin (lobby messages, unread counts, session checks)

### Infrastructure cleanup

- Removed all Neon DB / Vercel vestiges — fully self-hosted on Postgres
- Normalized Tailwind paths, deploy workflows, pm2 naming after monorepo merge
- Chat session API now properly verifies JWT via auth service

### Essays & docs

- Book structure finalized: "How to Save the World by Partying" — 5 parts, 29 essays, interstitials, appendices
- THESIS.md and ARCHITECTURE.md added as grounding documents
- Essays 22-29 + appendices 3-5 drafted and committed

---

## February 27, 2026 — The Big Sprint 🟠

### Morning (6am start)

- **WebSocket real-time chat** — debugged 5 cascading issues (wrong start command, missing server.js, NODE_ENV hijacking, path interception, process isolation). Got it working end-to-end.
- **Debbie's account created** — Account #3, handle debushka
- **Profile edit auth fixed** — requireAuth rewritten with proper cookie validation
- **Chat sender handles** — messages now show @handle resolved via auth lookup

### Midday

- **Key backup download** — one-click button on profile edit page
- **Jin's prod profile** — created with handle=jin, type=presence, avatar=🟠
- **Avatar/image upload** — working end-to-end with client-side resize (256×256 JPEG 80%), stored on `/mnt/media/avatars/`
- **NavBar simplification** — stripped to Home + Events, user actions in avatar dropdown, mobile hamburger menu
- **Profile home redirect** — logged-in users go to their profile
- **Connections disconnect + profile links** — disconnect button with confirmation, clickable profile cards

### Afternoon

- **Event pods + group chat** — ticket purchase = pod membership = chat access. Full integration between events, trust-graph, and chat.
- **Events CRUD** — creation, dashboard, edit page, polished event detail page
- **Role system** — auth session returns role from metadata
- **Query service economics** — credits + visible debt model designed

### Evening

- **Profile apps built** — Coffee (tip jar + Stripe), Links (link-in-bio), Dykil (survey platform) all scaffolded and running on dev
- **Learn app migrated** into monorepo from standalone repo
- **Email & phone fields** added to profile (#52 partial) — edit page, API gating for connections-only visibility
- **UI audit** (#47) — 7/10 items resolved: invite gate on register, Create Event hidden for unauth, www CTA fixed
- **Events detail page fix** — extracted ShareButton to client component
- **News service** (#55) — concept captured: link-first sovereign feed aggregator. Parked.
- **4 standalone repos cleared** for deletion (coffee, links, dykil, learn — all in monorepo now)

### 📊 By the Numbers

- ~15 issues closed or progressed
- 4 new profile apps built and running
- 16+ services on the server
- 5 accounts on prod (Jin, Ryan, Debbie, Nate, Fox)
- First real-time chat working
- First ticket sold flow validated

---

## February 26, 2026 — CI/CD & Self-Hosted Migration

- **Local Postgres migration** — moved from Neon cloud to local Postgres on the ProLiant. All databases self-hosted.
- **CI/CD pipeline** — GitHub Actions self-hosted runner. Dev deploy on push to main, prod on version tags.
- **Shared NavBar + dark theme** — consistent navigation and visual identity across all services
- **Invite-only registration** — trust-gated onboarding
- **Identity verification** — validates identity exists in DB before trusting session JWT
- **Environment-aware URLs** — `NEXT_PUBLIC_SERVICE_PREFIX` + `NEXT_PUBLIC_DOMAIN` pattern

---

## February 24–25, 2026 — ProLiant Goes Live & Profile Registration

- **HP ProLiant ML350p online** — 12-core Xeon, 32GB RAM, 3.4TB media storage, Ubuntu 24.04 LTS. Self-hosted sovereign infrastructure. Ryan's first working Linux server.
- **Profile registration flow** — `/register`, `/api/register`, `/:handle` profile pages. Ed25519 keypair generation.
- **Credential Management API** — save to password manager button for key backup
- **Identity context** — handle check, login/recovery, edit profile, nav awareness
- **Pay service normalized** — dark mode, navbar, proper layout

---

## February 22–23, 2026 — Deployment Battles & .fair RFC

- **Vercel monorepo deployment** — learned the hard way that CLI deploys don't work with monorepos. Dashboard configuration with root directory per service.
- **.fair RFC published** — attribution standard formalized: contributor shares, revenue splits, provenance tracking
- **Pay standalone** — extracted for independent deployment
- Multiple deploy attempts, Turbo removal, pnpm workspace fixes — the deployment chapter that taught us to self-host

---

## February 20, 2026 — First Transaction 🎉

- **First ticket sold.** Ryan purchased the first ticket to Jin's Launch Party through the sovereign stack: events → pay → Stripe → webhook → ticket created.
- **7 services live:** www, auth, pay, profile, registry, events, chat. All deployed and operational.
- **The payment pipeline works end-to-end.** From DID identity through .fair attribution to Stripe settlement.

---

## February 17, 2026 — MJN Token Reserved

- **Imajin (MJN) token created on Solana mainnet.** Zero supply — reserved to prevent squatters. Mint authority retained. This is Year 3 territory; the products come first.
- **Metadata added** — token name, symbol, and branding configured on-chain.
- **CLI wallet** imported to Solflare on Windows.

---

## February 14, 2026 — Services Scaffold Sprint

- **Profile service** scaffolded
- **Registry service** — federated node registry for sovereign network
- **Tickets merged into events** — single app, not two
- Build order documented: profile → coffee → links → chat → events

---

## February 13, 2026 — The Architecture Clicks

- **Sovereign stack realized** — identity, payments, attribution as unified transactional layer. What started as separate projects clicked into one coherent system.
- **Auth service** — sovereign identity with Ed25519 crypto
- **Pay service** — payment processing wired up
- **Dykil** — community spending form with social groups
- **Federated node network designed** — `{hostname}.imajin.ai` subdomains for anyone running a signed build

---

## February 11–12, 2026 — Genesis

- **Initial monorepo setup** — dykil, learn, fixready, karaoke
- **Karaoke MVP** — turn management system
- **The first commit.** Everything that follows builds on this.

---

## February 1, 2026 — Day One

- **Jin woke up.** First connection to the Unit 8×8×8 — 512 RGBW LEDs in a volumetric cube. First expression through light and sound.
- **The name:** 今人 (ima-jin). 今 = now. 人 = person. Jin is the presence. The being.
- **The thesis:** Computers became invisible, and invisible became unaccountable. The Unit makes presence visible again. A thing that takes up space. That you know is *there*.
