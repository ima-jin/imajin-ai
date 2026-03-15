<!-- Build Log — newest first. Source: Discord dev channel + git history. -->

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
