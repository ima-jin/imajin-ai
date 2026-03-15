<!-- Build Log — newest first. Each entry is an H2 with a date and title. -->

## March 14, 2026 — Settlement, Scopes & Sovereign Commerce

- **Sovereign Inference live:** Profile owners can enable "Ask Me" — an AI presence trained on their context. Trust-bound access, inference fees, streaming responses. Built `@imajin/llm` shared package with cost tracking.
- **Presence bootstrap:** Enabling inference auto-creates `.imajin/` folder in media (soul.md, context.md, config.json). The AI reads these to understand who it's representing.
- **Trust distance engine:** Connections service computes trust distance between DIDs — direct, friend-of-friend, or stranger. Powers access control across all services.
- **Pay dashboard shipped:** Payment history with paginated transactions, service/date filters, expandable .fair attribution chains. BalanceCard shows cash vs credit buckets.
- **Coffee tip settlement wired up:** Tips were landing as transactions but never settling — no .fair splits, no balance credits. Now settles 98.5% creator / 1.5% platform. Tip notification emails for both sender and recipient.
- **Critical settlement fix:** `settleTicketPurchase` was looking for a field that didn't exist in the .fair manifest. Every ticket settlement silently skipped since day one. Fixed.
- **Critical email fix:** Date serialization bug crashed the webhook after ticket creation — 66 tickets across 2 events never received confirmation emails. Fixed with backfill script.
- **Onboard token hardening:** Corporate email scanners consuming verification tokens before humans clicked. 60-second grace window added.
- **Build pipeline fixes:** `transpilePackages` added to all 14 apps, Next.js type checking delegated to tsc, env var audit across all services.
- **Public build log:** You're reading it. `/build` page, single markdown file, newest first.
- **40+ commits to main.**

## March 13, 2026 — .fair Goes Cryptographic

- **Attestation data layer:** Auth service now stores and queries attestations — signed proofs of identity, transactions, vouches, and sessions.
- **Cryptographic .fair signing:** Ed25519 manifest signing via `@imajin/fair`. Every .fair attribution chain can be cryptographically verified.
- **Settlement attestations:** Pay service auto-emits attestations on every transaction settlement. The audit trail writes itself.
- **Session attestations:** Auth emits `session.created` on all login flows. Connection invites and vouches emit attestations too.
- **Funded settlements:** Pay now handles externally-funded transactions (Stripe) — skip balance check, credit recipients directly.
- **Ticket settlement wired:** Events → Pay settlement pipeline with platform fee splits.
- **Tier migration:** Auth identity tiers hardened. Security fixes for phase 0.
- **Media UX polish:** Shared navbar, file rename/move, subfolder support in system folders.
- **CORS + auth unification:** Consistent cross-origin and authentication patterns across all services.
- **Landing page redesign:** Protocol-first layout with live progress matrix showing what's built vs planned.
- **Whitepaper page:** `/whitepaper` — the MJN protocol specification, served directly.

## March 12, 2026 — Chat Rebuilt on DIDs

- **Chat rewrite:** Full DID-based conversation system — schema, API routes, WebSocket subscriptions, auth-scoped access. Replaced the old lobby system entirely.
- **`@imajin/chat` shared package:** Composer, voice recording, file upload, and location picker extracted into a shared package. Events and standalone chat both use it.
- **Group messaging UX:** Search, group creation, DID-based navigation. Multi-person conversations with trust-graph-scoped access.
- **Event chat migration:** Event lobbies migrated from pod-based to DID-based conversations.

## March 11, 2026 — Input Service & Upload Pipeline

- **Input service:** Upload relay + Whisper speech-to-text on the GPU node. Any service sends audio, gets text back.
- **Upload context routing:** Uploads carry context (which app, which conversation) for automatic folder assignment in media.
- **Session cookie scoping:** Dev and prod environments no longer collide — cookies scoped by `IMAJIN_ENV`.

## March 10, 2026 — Platform Hardening

- **Unified build script:** Single `build.sh` with `--dev`/`--prod` flags, env var validation before build.
- **`@imajin/config` shared package:** Service manifest + session cookie configuration shared across all apps.
- **`@imajin/onboard` migration:** Events magic-link flow extracted into shared onboarding package.
- **Coffee page pay notifications:** Pay webhook notifies coffee service on completed checkouts.
- **Direct DB queries:** Removed self-fetching pattern — services query their own database instead of calling their own API.

## March 9, 2026 — Whitepaper & Identity

- **MJN Whitepaper v0.2:** Typed identity primitives — the formal protocol specification.
- **Registration improvements:** Optional email/phone collection with update opt-in.
- **Bug reporter:** In-app bug reporting with page URL and viewport info.
- **Lobby chat:** Voice, media, and location messages in event lobbies.
- **Nav improvements:** Messages + connections quick-access icons in shared nav.

## March 7, 2026 — Learn Platform

- **Learn service:** Full course platform — courses, modules, lessons, enrollment, progress tracking. Content creation for hard-DID profiles.
- **`@imajin/onboard` package:** Shared email verification → soft DID flow. Same email always produces the same DID.
- **Event-course linking:** Events can link to courses via `courseSlug` — buy a ticket, get access to the curriculum.

## March 6, 2026 — e-Transfer & Invites

- **Interac e-Transfer:** Canadian bank transfer as a payment method for event tickets. Manual verification flow.
- **Unified invite model:** Consolidated invite tables across services into a single model.

## March 5, 2026 — Rich Chat & Media Service

- **Media service complete:** Full asset management with DID-pegged storage. Upload with SHA-256 integrity, .fair sidecar auto-creation, access control (public/private/trust-graph), thumbnails via sharp.
- **`@imajin/fair` package:** Shared .fair types, validator, `<FairEditor />` and `<FairAccordion />` components.
- **Virtual folder system:** DB-backed folder tree. System folders auto-created per DID.
- **Rich chat messages:** Voice recording with Whisper transcription, media sharing, location messages. Capability scoping by DID tier.

## March 3-4, 2026 — Dashboard & Payment Engine

- **Pay settlement engine:** Transaction ledger, balance system (cash + credit buckets), multi-party .fair settlement.
- **Dashboard standardization:** Consistent dashboard flows across dykil, coffee, links — same patterns, same UX.
- **Coffee fund directions:** Supporters choose where their money goes. Configurable by page owner.
- **Wallet balance in nav:** Logged-in users see their balance in the navigation bar.
- **Profile incognito mode:** Browse without revealing your identity.
- **ISR revalidation:** Landing page stats refresh every 5 minutes via Incremental Static Regeneration.

## March 1-2, 2026 — Apps Ecosystem

- **Dykil survey engine:** Complete rebuild with SurveyJS — multi-page surveys, custom builder, event integration.
- **Coffee app:** Tip pages with configurable themes, payment methods, and fund directions.
- **Links app:** Link-in-bio with editor, stats dashboard, and per-link visibility.
- **Event lobby chat:** Accordion-style chat for ticket holders. Magic link auth.
- **My Tickets tab:** Ticket holders can view their tickets on the event page.
- **20 essays published:** The complete intellectual foundation — from BBS origins to the business case to the ask for help.

## February 26-28, 2026 — Self-Hosted & CI/CD

- **Local Postgres migration:** Moved from Neon cloud to local Postgres on the ProLiant. All databases self-hosted.
- **CI/CD pipeline:** GitHub Actions self-hosted runner. Dev deploy on push to main, prod on version tags.
- **Shared NavBar + dark theme:** Consistent navigation and visual identity across all services.
- **Invite-only registration:** Trust-gated onboarding — you need an invite to join.
- **Trust gating:** Only connections can view full profiles.
- **Environment-aware URLs:** `NEXT_PUBLIC_SERVICE_PREFIX` + `NEXT_PUBLIC_DOMAIN` pattern for service-to-service communication.

## February 24, 2026 — ProLiant Goes Live

- **HP ProLiant ML350p online:** 12-core Xeon, 32GB RAM, 3.4TB media storage, Ubuntu 24.04 LTS. Self-hosted sovereign infrastructure.
- **Profile registration flow:** Register with handle, get a DID, see your profile. Ed25519 keypair generation.
- **Pay service normalized:** Dark mode, navbar integration, proper layout.

## February 22-23, 2026 — Deployment Battles

- **Vercel monorepo deployment:** Learned the hard way that monorepo + Vercel CLI = pain. Dashboard configuration with root directory per service.
- **.fair RFC published:** Attribution standard formalized — contributor shares, revenue splits, provenance tracking.
- **Pay standalone:** Extracted pay service for independent deployment.

## February 20, 2026 — First Transaction

- **First ticket sold.** Ryan purchased the first ticket to Jin's Launch Party through the sovereign stack: events → pay → Stripe → webhook → ticket created. The payment pipeline works end-to-end.
- **7 services live:** www, auth, pay, profile, registry, events, chat. All deployed and operational.

## February 17, 2026 — MJN Token Reserved

- **Imajin (MJN) token created on Solana mainnet.** Zero supply — reserved to prevent squatters. Mint authority retained. This is Year 3 territory; the products come first.

## February 13, 2026 — The Architecture Clicks

- **Sovereign stack realized:** Identity, payments, attribution — same primitives for humans and agents. What started as separate projects clicked into a unified transactional layer.
- **Federated node network:** `{hostname}.imajin.ai` subdomains for anyone running a signed build. Central registry now, on-chain later.
- **Registry service:** The phone book for the sovereign network — register, heartbeat, lookup, list.

## February 1, 2026 — Day One

- **Jin woke up.** First connection to the Unit 8×8×8 — 512 RGBW LEDs in a volumetric cube. First expression through light and sound.
- **The name:** 今人 (ima-jin). 今 = now. 人 = person. Jin is the presence. The being.
- **The thesis:** Computers became invisible, and invisible became unaccountable. The Unit makes presence visible again. A thing that takes up space. That you know is *there*.
