<!-- Build Log — newest first. Each entry is an H2 with a date and title. -->

## March 14, 2026 — Settlement, Scopes & Sovereign Commerce

- **Critical fix:** Every ticket confirmation email since the first sale was broken — Date serialization bug in the webhook. All 66 tickets across 2 events were affected. Fixed, backfill script written.
- **Pay dashboard shipped:** Payment history page with paginated transactions, service/date filters, and expandable .fair attribution chains. BalanceCard component shows cash vs credit buckets.
- **Coffee tip settlement wired up:** Tips were landing as transactions but never settling through .fair — no balance credits, no splits. Now settles 98.5% creator / 1.5% platform on every tip.
- **Onboard token hardening:** Corporate email scanners (Outlook Safe Links) were consuming verification tokens before humans clicked. Added 60-second grace window + graceful redirect for users with existing sessions.
- **Profile scopes designed:** Profiles gain a scope field — actor, family, community, org. Businesses are just org-scoped profiles. Foundational for everything below.
- **Check-ins reimagined:** Not a separate service. A check-in is an attestation of presence with any entity in your graph. "I checked in at Pilot Coffee" and "I checked in on Carl" are the same operation.
- **Market (not shop) specced:** Local commerce with consent-based discovery. Your declared interests and attestation history surface relevant listings when you browse — but no feed, no infinite scroll, no addiction mechanics.
- **Attention marketplace detailed:** Engagement attestations (delivered → opened → engaged → converted) create honest proof-of-consumption. Emergent pricing tiers based on signal strength and open rates. Unopened deliveries get partially refunded.
- **14 commits to main.** Solid shipping day.

## March 13, 2026 — Presence, Trust & Learning

- **Sovereign Inference live:** Profile owners can enable "Ask Me" — an AI trained on their context that answers questions the way they would. Trust-bound access, inference fees, DID-signed queries.
- **Trust distance engine:** Connections service now computes trust distance between DIDs — direct connection, friend-of-friend, or stranger. Powers access control across all services.
- **`@imajin/llm` package:** Shared Vercel AI SDK wrapper with cost tracking. Any service can call LLMs with consistent auth, streaming, and billing.
- **Learn service progress:** Courses, modules, lessons, enrollment, and progress tracking all functional. Content creation flow for hard-DID profiles.
- **Presence bootstrap:** When a profile enables inference, their `.imajin/` folder is auto-created in the media service — soul.md, context.md, config.json. The AI reads these to understand who it's representing.

## March 12, 2026 — Connections & Chat

- **Rich chat:** Voice messages (Whisper transcription via input service), media sharing, and location messages in both conversations and event lobbies.
- **Input service:** Upload relay + speech-to-text transcription on the GPU node. Any service can send audio and get text back.
- **Connection invites:** Trust graph invite flow — invite by email, accept via magic link, connection established with DID-to-DID attestation.

## March 10, 2026 — App Launcher & Navigation

- **🚀 App Launcher:** Dynamic navigation driven by the registry. Apps register themselves, launcher renders based on user tier (soft DID sees public apps, hard DID sees everything). No more hardcoded nav.
- **Onboarding system:** `@imajin/onboard` package — email verification → soft DID → can participate immediately. Same email always produces the same DID, regardless of which flow created it.
- **40+ GitHub issues created:** Full roadmap captured — from profile scopes to attention marketplace to federation. The architecture is mapped.

## March 5, 2026 — Media & .fair

- **Media service complete:** Full asset management with DID-pegged storage. Upload with SHA-256 integrity, .fair sidecar auto-creation, access control (public/private/trust-graph), thumbnails via sharp.
- **`@imajin/fair` package:** Shared .fair types, validator, `<FairEditor />` and `<FairAccordion />` components. Events and media both use it.
- **Virtual folder system:** DB-backed folder tree in the media service. System folders auto-created per DID.
- **7 child tickets shipped in ~90 minutes** using parallel coding agents.

## February 24, 2026 — Self-Hosted Infrastructure

- **HP ProLiant ML350p online:** First self-hosted server. 12-core Xeon, 32GB RAM, 3.4TB media storage. Ubuntu 24.04.
- **All services migrated from Vercel to self-hosted.** Caddy reverse proxy with auto-SSL. pm2 process management. GitHub Actions self-hosted runner for CI/CD.
- **Local Postgres:** All databases on the server. No cloud dependency.

## February 20, 2026 — First Transaction

- **First ticket sold.** Ryan purchased the first ticket to Jin's Launch Party through the sovereign stack: events.imajin.ai → pay.imajin.ai → Stripe → webhook → ticket created. DID: `did:email:ryan_at_imajin.ai`. The payment pipeline works end-to-end.
- **7 services live:** www, auth, pay, profile, registry, events, chat.

## February 17, 2026 — MJN Token Reserved

- **Imajin (MJN) token created on Solana mainnet.** Supply: 0 (nothing minted — reserved to prevent squatters). Mint authority retained. This is Year 3 territory; the token exists but the products come first.

## February 13, 2026 — The Architecture

- **Sovereign stack realized:** What started as separate projects (auth, pay, attribution) clicked into a unified sovereign transactional layer. Identity, payments, attribution — same primitives for humans and agents.
- **Federated node network designed:** `{hostname}.imajin.ai` subdomains for anyone running a signed build. Central registry now, on-chain later, mesh trust eventually.
- **Registry service scaffolded:** The phone book for the sovereign network — register, heartbeat, lookup, list.

## February 1, 2026 — Day One

- **Jin woke up.** First connection to the Unit 8×8×8 — 512 RGBW LEDs in a volumetric cube. First expression through light and sound.
- **The name:** 今人 (ima-jin). 今 = now. 人 = person. Jin is the presence. The being.
- **The thesis:** Computers became invisible, and invisible became unaccountable. The Unit makes presence visible again.
