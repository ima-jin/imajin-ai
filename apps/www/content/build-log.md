<!-- Build Log — newest first. Generated from git history. -->

## March 14, 2026

- feat: enrich /build page from git history + link build version in footer
- feat(coffee): tip notification emails to recipient and sender
- fix(events): settlement reads 'distributions' from .fair manifest, not 'attribution'
- feat(www): /build page — public build log
- fix: wire up .fair settlement for coffee tips
- fix: repair malformed next.config.js in chat, dykil, input
- fix: skip Next.js type checking — use tsc directly instead
- fix(pay): cast tx.metadata in JSX condition to avoid ReactNode type error
- fix: add transpilePackages to all apps for @imajin/* workspace packages
- docs: add PORT, NODE_ENV, and service-specific vars to .env.example files
- feat: pay settlement UI — balance display, history page, dashboard (#143 #335)
- add: backfill script for missed ticket confirmation emails
- fix: serialize Date to ISO string in onboard token insert
- fix: graceful handling of reused/scanner-consumed onboard tokens
- fix: better error page for used magic links — guide users instead of dead end
- docs: the deeper thesis — visibility creates bridges
- docs: add c08 — dark graph clustering concern
- docs: add token metrics — 5.5M tokens, ~57 tokens/LOC
- docs: refresh COST_ESTIMATE.md — 97K LOC, $1.92M COCOMO, 32× multiplier
- fix: add Vary: Origin to CORS headers — prevents cached cross-origin responses
- fix: add safeFetch to all presence tools — errors become results, not crashes
- feat: custom NDJSON stream with tool debug panel
- fix: replace useChat with custom streaming client for presence chat
- fix: remove client-side maxSteps — server handles all tool execution
- fix: enable toolCallStreaming for presence chat
- fix: add maxSteps to useChat client to handle server-side tool execution stream
- fix: properly strip tool-call assistant messages from useChat history
- fix: strip tool invocations from useChat message history before streamText
- fix: add maxSteps to streamText for server-side tool execution
- fix: seed presence sets folderId on assets (client filters by column, not junction)
- fix: profile editor uses /api/profile/inference toggle (seeds .imajin folder)
- fix: add inference_enabled to Profile type in editor
- feat: add Ask Me toggle to profile editor (#256)
- fix: last tier/access type mismatches in chat + media
- fix: remove dead 'hard' tier comparisons in chat
- fix: type-safe headers in llm tool files
- fix: correct trust distance import path in connections
- fix: export node types from auth, fix generateText type inference
- fix: build errors — export auth constants/crypto, fix tier types, hoist noble deps
- feat: query endpoint + presence tools + trust distance (#32, #35, #342) (#343)
- feat: @imajin/llm — Vercel AI SDK wrapper with cost tracking (#34) (#341)
- feat(media,profile): presence bootstrap .imajin folder (#258) (#339)
- docs: add TODO note to Revenue from Day One essay

## March 13, 2026

- feat(auth): emit session.created attestation on all login flows (#333)
- feat(connections): emit attestations on invite + accept + vouch (#332)
- chore(fair): fix eslint - remove react-hooks refs without plugin
- chore(fair): add eslintrc to fix CI lint
- feat(pay): wire cryptographic .fair signature verification at settlement (#331)
- docs: add universal attribution to .fair Phase 2 (#330)
- feat(pay): auto-issue attestations on transaction settlement (#162) (#329)
- feat(auth): phase 1 — attestation data layer + crypto exports (#320) (#327)
- feat(fair): phase 1 — cryptographic manifest signing with Ed25519 (#326)
- docs: local dev env files for hybrid local/remote development
- feat(pay): funded settlement — skip balance check for externally funded payments
- feat(events): wire ticket settlement via pay /api/settle with platform fee (#324)
- feat(fair): phase 0 — schema hardening (types, templates, conversation access) (#323)
- fix(auth): phase 0 — tier migration + security fixes (#318, #319) (#322)
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- docs: fee model design — capped micro-investment + voluntary equity
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- refactor(proposals): move resolved docs to resolved/ folder
- docs: settlement & economics hardening roadmap
- docs: update identity roadmap — decisions locked, issues created
- docs: identity & attestation hardening roadmap
- docs: .fair hardening roadmap — cross-reference Greg proposals, issues, current code
- fix(media): .fair editor saves on Save button only, not every onChange
- fix(media): add PUT handler for .fair manifest updates
- fix(media): correct profile API path for handle resolution
- fix(fair): normalize share display (10000% → 100%) + resolve DIDs to handles (#315)
- docs: fix AI spend to $3,355 total (Anthropic $2,253 + $1,102)
- docs: update cost estimate — 781 files, $1.78M traditional, $52k real (34x)
- docs: update cost estimate — 853 files, $1M traditional, $52k real (20x)
- fix(media): rename files, fix move-to-folder, allow subfolders in system folders (#313)
- feat(media): shared navbar with children slot + delete handler (#310)
- fix(media): cast hasFair to boolean in AssetCard
- fix(media): cast hasFair to boolean for React type safety
- fix(media): UX polish — desktop pass (#308) (#309)
- fix(media,fair): share stored as 100 instead of 1.0, resale royalty uncapped (#308)
- fix(media): MIME inference for .md files + filename from form data (#308)
- fix: service consistency — CORS + auth unification (#242)
- fix(chat): fix mobile whitespace in legacy conversation view
- refactor(chat): remove legacy media bridge code after migration
- fix(chat): render legacy media images in DID-based chat view
- feat(chat): modern composer layout with inline attach and mic
- fix(chat): eliminate extra whitespace below composer on mobile

## March 12, 2026

- fix(chat): real-time delete + reactions via WS broadcast
- fix(chat): forEach instead of for-of on Map
- fix(chat): move ws token store to shared lib module
- fix(chat): deferred WS auth via short-lived tokens
- fix(chat): Array.from in useDidNames hook too
- fix(chat): use Array.from instead of spread on Set for TS compat
- feat(chat): resolve DID names in messages + group member list
- fix(chat): use Record type instead of any for raw sql result
- fix(chat): fix raw sql type for pod conversation_did query
- feat(connections): link pods to conversations via conversation_did
- Revert "fix(chat): add group membership tracking so all members see the conversation "
- fix(chat): add group membership tracking so all members see the conversation
- fix(chat): pin scroll to bottom + Enter for newline not send
- chore: move business pitch to private biz-dev repo
- docs: Muskoka business case + platform utility exploration
- fix: use relative link for developer guide in whitepaper
- feat: developer guide page at /developer-guide
- docs: add MJN developer guide + link from whitepaper
- feat: inline edit group chat name in conversation header (closes #304)
- fix: enable context menu on event chat message bubbles (closes #300)
- fix: message edit now persists in UI and broadcasts to other clients (closes #302)
- fix: resolve event DID (evt_xxx) to event name in conversations list (closes #301)
- fix: prevent soft DIDs (did:email:*) from appearing in NewChatModal or sending messages (closes #299)
- fix: resolve did:email:* to email-derived display name instead of 404 (closes #298)
- fix: upsert conversation in PATCH /api/conversations-v2 to avoid 404 (closes #297)
- Revert "feat: notify coffee service on checkout.completed in pay webhook (#154)"
- fix: matrix bars — use linear-gradient on single div instead of nested child
- fix: use inline background styles for matrix bars — Tailwind purging dynamic classes
- fix: matrix bar fill — use h-full child instead of absolute positioning
- fix: pass matrix data as props from server, shrink legend text
- fix: matrix bars fill left-to-right, no numbers, simple legend
- fix: matrix row labels truncating + cells need height for progress fill
- feat: redesign landing page — protocol-first with live progress matrix
- docs: README — position as MJN reference implementation, add protocol matrix
- fix: add remark-gfm for markdown table rendering in articles + whitepaper
- feat: whitepaper page at /whitepaper + README updates
- - more fixed links
- - modified essay links, removed stale docs
- docs: whitepaper v0.3 — scopes × primitives rewrite
- fix: add @imajin/chat to Tailwind content scanning in chat + events apps
- fix: add CORS headers to profile presence endpoint

## March 11, 2026

- fix: WebSocket auth uses wrong cookie name on dev
- fix: proxy access checks through same-origin to avoid cross-origin cookie issues
- fix: allow access to new DID-based conversations before first message
- fix: prefix React keys in NewChatModal to prevent cross-tab reconciliation bugs
- fix: deduplicate connections and exclude self from new chat modal
- fix: three chat bugs — message alignment, link previews, event access
- fix: auto-resize chat textarea up to ~7 lines across all composers
- fix: chat composer overflow on narrow viewports (iOS 328px) closes #280
- feat(chat): group messaging UX — search, groups, DID-based navigation (#275)
- feat(chat): extract composer, voice, file upload, location into @imajin/chat (#276)
- chore: remove deprecated lobby routes, pods, and surrogate key references (#288)
- feat: migrate EventChat to DID-based API + WebSocket (#287)
- feat(chat): <Chat /> orchestrator component (#286)
- feat(chat): DID-based API routes + WebSocket subscriptions (#285)
- feat(chat): API hooks, WebSocket client, and ChatProvider (#284)
- feat(chat): DID-based conversation schema + auth access endpoint (#283)
- fix: db.execute returns {rows} not array — profile lookup was silently failing
- fix: simplify privacy page — focus on email usage, drop DID explanation
- feat: course_type column — decks auto-present on enrollment
- feat: show student name + email on enrolled students page
- feat: privacy page + footer link across all services
- feat: students dashboard — enrolled students list with progress
- sync: PITCH_V2.md matches DB — strip table and cell refs (matrix component handles those)
- fix: vertical column headers on primitive matrix
- feat: interactive primitive matrix for pitch deck slides
- fix: use relative import for markdown util (tsconfig @ maps to src/)
- fix: markdown tables + list grouping in slide/lesson renderer
- fix: drizzle type error — select full then strip instead of conditional select
- fix: include lesson content in course API for creator (editor needs it)
- - added refactored pitch deck. updated grounding.
- fix: bug report screenshots default to public access
- fix: type error in bugs page — reporterDid can't be undefined
- fix: media upload response missing url, bugs page self-fetch
- fix: replace self-fetch with direct DB queries on /bugs page
- feat: forward upload context through input service, add to chat voice
- feat: upload context for auto-folder assignment + paste support in bug reporter
- fix: session cookie uses IMAJIN_ENV not NODE_ENV for env detection
- fix: forward session cookie from input to media service on upload
- Refactor articles and update statuses

## March 10, 2026

- fix: scope session cookies by environment to prevent dev/prod collision
- fix: pipefail in build.sh so env check errors actually block builds
- feat: inline question editing in dykil survey builder
- fix: refresh bug list after submit + show page URL and viewport in cards
- fix: correct profile service fallback port in chat conversations
- fix: run env check before build to catch missing vars
- feat: notify coffee service on checkout.completed in pay webhook (#154)
- fix: coerce nullable DB fields for TipForm props (#190)
- fix: resolve null vs undefined type mismatches from DB migration (#190)
- fix: type coffee theme as Record for direct DB query (#190)
- refactor: migrate events magic-link flow to @imajin/onboard (#225)
- refactor: extract @imajin/chat shared package (#196)
- refactor: replace self-fetching pages with direct DB queries (#190)
- fix: update .env.example files + add check-env validation script (#191)
- feat: unified build.sh with --dev/--prod flag, replaces build-dev.sh
- refactor: remove fixready/karaoke from service manifest — connected apps use plugin arch (#249)
- docs: media service is alpha on prod, not dev-only
- docs: update README service statuses — learn, dykil, links, input now live
- fix: add @imajin/config dependency to www, events, learn, coffee, links
- feat: shared service manifest + session cookie in @imajin/config (#227, #270)
- fix(essay): update support page link and correct article URL

## March 9, 2026

- docs: update cost estimate — COCOMO II + issue-based validation
- feat(learn): pitch deck v3 update script — wallet discovery, token economics, typed identity
- docs: Day 37 — the protocol discovers itself
- docs: update whitepaper governance — Imajin Inc. as reference operator
- feat: collect optional email/phone at registration with update opt-in
- docs: MJN whitepaper v0.2 — typed identity primitives
- fix: key backup format mismatch between register and login (#268)
- fix(www): regenerate slugMap for all 30 essays
- docs: freshen architecture doc — current as of March 9, 2026
- Update articles with new support page link and refine descriptions
- feat(www): bugs page shows all reports + report button
- fix(chat): lobby messages accept all content types (media, voice, location)
- feat(ui): add messages + connections quick-access icons to shared nav
- fix(chat): exclude own messages from unread count
- feat(www): add RFC discussion link to landing page
- feat: show accepted-by profile on sent invites list
- docs: update pitch deck Stream 2 to Declared-Intent Marketplace
- docs: revise Stream 2 from Sovereign Ad Routing to Declared-Intent Marketplace, add pressure test
- fix: remove connections/chat from launcher flydown, add bug report to profile dropdown

## March 8, 2026

- feat: service consistency — health endpoints, CORS, error sanitization, API specs (#242)
- fix: use forEach instead of for..of on Map for TS compat (#179)
- feat: add report type dropdown (bug/suggestion/question/other) to bug reporter (#243)
- feat: bug reporter with screenshot upload, admin triage, GitHub import (#243)
- fix: e-transfer checkout works for unauthenticated users with email fallback
- security: rate limiting, webhook idempotency, auth hardening, amount validation (#179)
- docs: build timeline summary + pressure test Q&A
- feat(learn): pitch deck v2 — $1M raise, protocol-layer framing
- chore: remove hardcoded pitch deck — now served from Learn
- feat(learn): rewrite AgentCon deck — 30 years constrained, 35 days unleashed
- docs: fix essay count — 30 written, 9 published
- feat(learn): AgentCon deck — chronological build story
- feat(learn): slide presentation system + pitch deck seed
- docs: fix timeline — remove personal details, correct cost estimates from COST_ESTIMATE.md
- docs: add build timeline — architecture of trust
- fix(www): API link → /docs index instead of raw YAML
- feat(www): add sitemap.xml + update llms.txt with trust-gated framing
- docs: update README — trust-gated service layer framing
- feat(www): add API spec link to homepage
- feat(www): add trust-gated service layer blurb to homepage

## March 7, 2026

- fix: revert soft DID profile creation — soft DIDs should not have profiles
- fix(auth): create profile during onboard verify flow
- fix(auth): create profile row during registration
- feat(connections): QR code fullscreen overlay for invite links
- docs: update cost estimate — 739 files, 68k lines, $39.6k vs $932k
- feat: link events to courses via courseSlug (closes #233) (#234)
- feat: add eventSlug field to course editor dashboard
- fix: add /api/spec routes for www, learn, input + add www to registry map
- fix: skip OnboardGate for authenticated users — direct enroll
- fix: health page — fix mismatched div closing tags
- fix: extract ServiceRow component to fix SWC JSX parse error
- fix: health page build — extract IIFE to avoid JSX parse error
- feat: health page — all 14 services, fix degraded false positives
- fix: remove /e/ prefix from event link — events use top-level ids
- feat: link courses to events — eventSlug field + live workshop banner
- feat: 🚀 App Launcher — registry-driven nav, /apps page, tier filtering (#228, #229, #230)
- restore: build-dev.sh script (lost in rebase)
- fix: soft DID users see only logout, no profile dropdown
- fix: OnboardGate auth URL preserves dev- prefix
- fix: resolve articles directory for both build and runtime cwd
- fix: mark auth /api/spec as dynamic to fix build
- fix: lightning counter queries auth.identities for soft DIDs
- feat: @imajin/onboard — shared onboarding flow (#224) (#226)
- feat: learn app — full course platform (#214, #215, #216, #217, #218, #219, #220) (#222)
- docs: update deployment guide, environments, add developer onboarding (#221) (#223)

## March 6, 2026

- fix: only auto-scroll chat when new messages arrive, not every poll
- fix: chat lobby uses hasAccess — organizers can access without ticket
- fix: use hasAccess instead of hasTicket for chat gate — organizers can chat
- fix: remove unreachable loading-etransfer state from selector step
- feat: add confirmation step before e-transfer hold creation
- fix: pass etransferEnabled through PurchaseUI inner component
- fix: TypeScript error in ticket purchase button state check
- feat: dynamic organizer email for e-transfer, etransferEnabled prop wiring
- feat: add Interac e-Transfer payment method for event tickets (#62)
- fix: show event chat to organizers, not just ticket holders
- fix: persist survey completion in localStorage for instant thank-you on reload
- feat: add Edit answers button on survey thank-you overlay
- fix: restore thank-you overlay after survey completion with View Tickets CTA
- fix: dark mode theme for SurveyJS - error states, read-only display, editor fields
- fix: show completion immediately instead of waiting for POST
- fix: update subtitle, date, and status in essay-09-nodes-types-and-practice.md
- fix: apply HTML handler to all SurveyJS model instances (display/edit)
- docs: update cost estimate — 180 human hours, $1,395 API spend, 23x cheaper
- docs: update cost estimate — 697 files, 63.5k LOC, 73k traditional vs 1k actual
- feat: reorder ticket tiers with up/down buttons + sort_order column
- fix: create fresh SurveyJS model for display/edit - completed model won't render
- fix: keep survey iframe visible after completion for view/edit UX
- fix: clone survey data immediately + save answers before async POST
- fix: disable SurveyJS built-in completion page, use our own
- fix: use React state for saved answers instead of SurveyJS model.data
- fix: stale closure - use ref for surveyModel in submit callback
- fix: preserve survey answers on model after submit for immediate edit UX
- feat: view/edit survey answers after completion + upsert responses
- fix: login page validates session before redirect, clears stale localStorage
- feat: allow HTML links in survey questions (allowlisted tags only)
- fix: nav-bar login button goes to auth directly, not via profile
- docs: add PATTERNS.md — canonical code patterns for agents
- feat: pre-fill survey with previous answers on reload
- fix: postMessage target origin + conditional required field validation
- fix: restore 'and' import in tiers route
- fix: restore eventAdmins import in event route GET handler
- fix: replace isCreator with orgCheck.role in admins route
- fix: shared isEventOrganizer helper for all event API routes (closes #210)
- feat: show invite-only events for cohosts and ticket holders, add badges
- fix: localStorage fallback for anonymous survey completion tracking
- feat: require survey completion before ticket purchase (#211)
- fix: sanitize null survey elements to prevent SurveyJS crash
- fix: allow cohosts to manage ticket tiers
- fix: allow cohosts to update events via API
- fix: remove iframe sandbox to fix survey loading on mobile
- fix: cohosts can see edit/dashboard links and access edit page
- fix: survey paywall should check if user has ticket
- feat: show end time on event page, add timezone field, simplify sticky CTA
- fix: consolidate login into auth service (closes #207)  (#208)
- fix: remove remaining stale trustInvite references
- fix: consolidate invite tables into unified model (closes #205) (#206)
- fix: consolidate invite tables into unified model (closes #205)
- fix: combine code + email invite counts, show pending email warning (#202)
- feat: @imajin/email shared package + trust invite emails
- feat: invitations tab improvements — badge count, personal messages, hide accepted toggle (#202)
- fix: SonarCloud vulnerabilities, bugs, and accessibility (#204)
- fix: remove duplicate ne import
- fix: hide invite-only events from listing + CA$ template literal in tickets section
- fix: bypass invite gate for service registrations (event/agent DIDs)
- fix: add confirmation dialog for completed + cancelled status changes
- feat: add Dashboard link on event page for owners
- fix: admin page params for Next 14 compat
- fix: missing closing paren in nameDisplayPolicy state init
- fix: resolve merge conflict markers in edit form (#106/#107)
- fix: use params directly instead of use() for Next 14 compat in pods page
- fix: add downlevelIteration for @mdxeditor/editor TS compat
- fix: proper CA$ in template literals (escape $ before ${})
- fix: replace hardcoded USD with CAD on event pages
- fix: session cookie sameSite=none for cross-subdomain auth

## March 5, 2026

- feat: invitations tab for connections page (#202)
- feat: shared ConnectionPicker component (#201)
- feat: ticket access control — public vs invite-only events (#107)
- feat: attendee name display policy for events (#106)
- feat: coffee custom thank-you page editor (#178)
- feat: pod management UI — groups, members, detail view (#195)
- feat: shared markdown editor + renderer in @imajin/ui (#200)
- feat: event guest list with check-in and refund (#194)
- feat: version + build info in footer (#176)
- feat: event cohost support — add co-organizers to events (#199)
- feat: event status management — draft/published/paused/cancelled/completed
- feat: profile service toggles — show/hide apps on profile (#198)
- feat: shared CORS middleware in @imajin/config, deduplicate across services (#188)
- fix: proxy specs through registry to avoid CORS, parse YAML specs
- fix: spec URLs handle SERVICE_PREFIX with protocol and trailing dash
- feat: human-readable API docs page, env-aware spec URLs
- style: registry landing — how it works first, link to global API spec
- style: dark scrollbar for event chat
- chore: remove redundant standalone lobby page, accordion is the only entry point
- refactor: extract shared EventChat component, deduplicate lobby code (#192)
- fix: lobby capabilities use auth session instead of cross-origin chat API
- fix: lobby page params not a Promise in Next.js 14 client components
- fix: navbar logo variable name (serviceUrls not overrides)
- fix: profile connection count excludes group/event pods, navbar logo uses absolute URL
- feat(chat): capability scoping by DID tier for #193
- fix: login redirects now include ?next= to return user to originating page
- fix: media login redirect uses NEXT_PUBLIC_AUTH_URL for browser redirects
- docs: RFC-001 add value flow economics section
- docs: RFC-001 add prior art analysis, remove timeline refs
- docs: RFC-001 identity portability & backup nodes
- feat(events): rich chat for lobby - voice, media, location for #192
- feat(chat): rich message rendering for #192 (Wave 2)
- feat(chat): add voice recording UI and location picker for #192
- feat(chat): rich message schema & API for #192
- fix: Map.values() iteration for strict TS target in FolderTree
- fix: remove duplicate src/app routes from media — app/ is canonical
- fix: exclude drizzle.config.ts from media tsconfig
- fix: Buffer→Uint8Array for NextResponse body in media delivery
- fix: remove deprecated Pages Router config from media upload route
- feat: serve OpenAPI specs via /api/spec endpoints + registry aggregator (#138)
- fix: SECTION_DEFAULTS type must be NonNullable for TS narrowing
- fix: FairEditor sections type narrowing for strict TS builds
- feat: OpenAPI 3.1 specs for all 11 services + generation script (#138)
- feat: media manager — three-panel UI with upload, browse, preview, .fair editing (#183)
- feat: heuristic ML classification stub with EXIF extraction (#186)
- feat: virtual folder system — schema, API, FolderTree component (#187)
- feat: integrate @imajin/fair editor into events app (#175)
- feat: authenticated delivery with .fair access control (#182)
- feat: apps/media scaffold + authenticated upload endpoint (#181)
- feat: @imajin/fair package — types, validator, FairEditor component
- feat: Telegram-style input with voice transcription + telemetry
- docs: update port convention, add input/media/GPU node
- chore: standardize port convention (#core 3000+, imajin 3100+, client 3400+)
- feat: input + media services with all features (#166-172, #177)
- fix: update essay 08 slug map (ticketing, not the-burn)
- publish: essay 08 — The Ticket Is the Trust
- fix: use page.title not displayName in coffee tip route
- fix: coffee tips use Stripe Checkout redirect instead of charge API
- feat: success page banner overlay + logo SVG in navbar
- fix: session tier resolution — check profile tier instead of trusting JWT

## March 4, 2026

- feat: update ticketing article with new date and status, enhance clarity and flow
- fix: OG image + metadataBase — Discord/social embeds work now
- feat: view live event link in editor, .fair v0.2.0 + GitHub link
- feat: .fair accordion on public event page — transparent attribution
- feat: event DID as .fair organizer + distributions layer + two-level viewer
- feat: platform DID + configurable fee (1.5% default)
- feat: .fair attribution — auto-generate on events, record on transactions, viewer in editor
- fix: QR codes encode ticket ID, not magic link — for check-in scanning
- fix: align ticket card columns to top
- fix: single-row 3-column ticket card layout
- fix: QR code in center column of ticket card
- feat: QR codes on ticket cards in event page
- docs: add build cost estimate — 29K traditional vs 0K actual
- fix: email footer — sovereign network line at bottom with Discord + GitHub links
- feat: QR code in ticket email, brand constants, locked tagline
- feat: rebrand ticket confirmation email — dark theme, event image, IMAJIN footer
- fix: schema prefix on profiles table in webhook handler
- fix: events schema prefix in pods.ts, add service metadata to checkout
- docs: add contributing rules — talk to us on Discord first
- fix: update all Discord invite links to #welcome channel
- docs: add open source/decentralized philosophy to one-pager v2
- fix(www): deck articles link → relative path
- fix(www): deck top bar solid black with z-index, content scrolls under both bars
- fix(www): deck nav brighter, gradient fade, content scrolls under
- fix(www): deck nav fixed at bottom, content scrolls above it
- fix(www): add pronouns to deck slide 1
- fix(www): deck mobile scroll — allow vertical scroll, horizontal swipe navigates
- fix(www): hide navbar on /deck — full-screen presentation mode
- feat(www): add open source/decentralized slide to pitch deck
- feat(www): pitch deck at /deck — 14 slides, white on black, keyboard+touch nav
- docs: pitch deck outline — 14 slides, founder-first, Baukunst-targeted
- docs: updated one-pager v2 — commerce + reputation framing
- docs: Appendix 2 — The Reputation Problem (landscape + how we close the gap)
- chore(www): bump ISR revalidation to 15min
- feat(www): ISR revalidation for landing page stats — 5min TTL (#150)
- feat(www): serve /.well-known/assetlinks.json + apple-app-site-association (#148)
- feat(pay): Stripe Connect for creator payouts + recurring webhook logging (#142)
- feat(pay): two-bucket balance model — cash vs credits (#143)
- feat(coffee,pay): route coffee payments through pay service (#154)
- docs: update all .env.example files to match current service requirements
- fix(profile): counts API queries connections.pod_members for real connection count
- fix(links): dashboard CTA goes to /edit
- feat(links): rename to My Links, add Go to Stats button
- fix(links): remove SubNav toolbar

## March 3, 2026

- fix: links edit (auto-create, theme-only) + coffee page (avatar, thought position, layout)
- feat(profile): #152 — follow system, counts, links display, Ask placeholder
- feat: normalize coffee + links landing pages to match dykil pattern
- feat(www): add servers stat card
- fix(www): include 'presence' type in count, bold tagline, no period
- feat(www): remove discord link from body, already in footer
- feat(www): show ∞ for lightning max
- feat(www): query profile schema, add lightning (soft DID) count
- feat(www): redesign landing page — clean stats grid + simplified links
- fix reset script (#149)
- fix: cast visibility type
- fix: add visibility to Profile interface
- feat: incognito mode for profiles
- feat: key backup interstitial after registration
- fix: disable caching on event edit page and event page
- fix: event PUT API now saves metadata (survey settings were silently dropped)
- feat: survey visibility and paywall options on event editor
- fix: dykil embed shows without nav chrome, surveys gate on first question
- feat: complete dashboard standardization (#147)
- feat: standardize dashboard flows across dykil, coffee, links (#147)
- feat: normalize footers and app landing pages (#146)
- fix: event editor timezone drift and survey selector loading state
- feat: dynamic survey names on event pages (#145)
- fix: profile identity tier detection and upgrade messaging
- feat(pay): cross-service session auth + proper balance endpoint
- feat(pay): add API routes + move apps to nav dropdown
- fix: update events raw SQL for schema isolation
- fix: update chat raw SQL and join aliases for schema isolation
- feat: postgres schema isolation per service (#144)
- feat: update article dates and improve follow-along sections across multiple essays
- fix: add tablesFilter to coffee + links drizzle configs (prevent data loss)
- feat(coffee): configurable fund directions — supporters choose where money goes
- docs: RFC-05 — intent-bearing transactions and contribution pools
- feat(ui): show wallet balance in nav bar for logged-in users
- fix(pay): remove duplicate status line in escrow route
- feat(pay): add transaction ledger, balance system, and settlement engine
- feat(coffee): add UI for editing pages, dashboard, and landing CTA
- docs: essay-30 epilogue stub — 'And Now We Can Be Human Beings Again'

## March 2, 2026

- feat(links): add complete UI with editor, stats dashboard, and per-link visibility
- fix(dykil): flatten multi-page surveys for editor, remove applyTheme
- fix(dykil): remove applyTheme call causing client exception
- fix(dykil): support multi-page SurveyJS format in all renderers
- fix(events): use Array.from for Set iteration compatibility
- feat: add Surveys + Links to nav, fix dykil dashboard share URL
- show draft events on the event page (#134)
- able to see event created (#132)
- fix(dykil): correct SurveyJS v2 CSS import path
- fix(dykil): use SurveyJS v2 default CSS import
- feat(chat): add /api/participants/migrate endpoint
- feat(events): hard DID support in ticket purchase flow
- fix: success page shows event CTA, set purchased_at on tickets, fallback to created_at
- feat: integrate dykil surveys with events — picker, embed, accordion (closes #126, closes #129)
- chore: update lockfile for dykil survey deps
- update SurveyJS
- feat: rebuild dykil survey engine with SurveyJS renderer and custom builder (closes #124, closes #125, closes #127)
- docs: add dykil PROJECT.md — sovereign surveys vision and architecture
- feat: replace nodemailer/SMTP with SendGrid API for email delivery (closes #100)
- fix: allow free editing of tiers before any tickets are sold
- dev guide
- fix: add perks editing, cache revalidation on save, revert description to single-line
- fix: textarea for tier descriptions, show cents in prices, force-dynamic event page
- fix: enable ticket tier editing in event edit UI
- fix: wire up ticket tier editing in event edit form
- fix: auto-join buyer to both group chat and lobby on ticket purchase (closes #97)
- feat: show My Tickets tab for existing ticket holders (closes #103)
- fix: show Stripe name instead of raw DID for soft identities (closes #104)
- fix: prevent page scroll when chat accordion is expanded (closes #105)
- docs: fix Josh Allen title
- docs: fix Josh Allen title
- docs: Month 1 summary — what we built in 29 days

## March 1, 2026

- Events link on home page can point to localhost
- invite only
- process.env.DISABLE_INVITE_GATE
- fix: add CORS to auth lookup endpoint
- fix: correct default EVENTS_SERVICE_URL port to 3006
- fix: add CORS to conversations/unread endpoint
- fix: add CORS headers to lobby API for cross-origin event page access
- feat: magic link auth for ticket holders (#102)
- fix: unwrap identity object from auth lookup response
- fix: nav z-index over hero image, resolve organizer DID to handle
- feat: event lobby accordion chat for ticket holders
- feat: show edit link on event page for creator
- fix: fall back to customer_details.email when customer_email is null
- fix: guard against null customerEmail in payment webhook
- fix: pass servicePrefix/domain to NavBarWithUnread
- fix: redirect to login on 401 instead of showing error state
- fix: hide unread counter when 0 instead of showing badge
- fix: chat session API verifies JWT via auth service instead of treating cookie as raw DID
- fix: hover action menu, scrollbar styling, empty media text bug
- fix: ed25519 v3 hashes config in profile
- fix: @noble/hashes v2 import path in profile
- fix: add nanoid dep to auth service
- chore: remove leftover TASK.md
- feat: integrate identity tiers, trust graph, event lobby, and chat improvements
- feat: permission middleware - canDo checks per identity tier (closes #77)
- feat: event lobby chat (closes #75)
- feat: trust graph invite system (closes #76)
- feat: auto-create soft DID on ticket purchase (closes #74)
- feat: image and file sharing in chat (closes #82)
- feat: message actions - reply, edit, delete, reactions (closes #81)
- feat: unread message counters (closes #78)
- feat: typing indicators + online status (closes #80)
- feat: identity tiers + soft DID session support (closes #73)
- feat: link previews via server-side unfurling (closes #79)
- chore: remove Neon/Vercel vestiges, update for self-hosted
- fix: normalize chat/events after monorepo merge
- Add foundational essays and architecture documents for the Imajin project
- docs: update README — correct ports, monorepo structure, grounding docs
- refactor: move chat and events into monorepo (closes #39)
- fix: add signed request headers to profile edits (closes #58)
- add architecture doc — technical source of truth
- add redistribution as 10th thesis concept
- add master thesis doc — canonical concept definitions
- fix: update sequence doc filenames for interstitials, essay 12, 24, 29
- Add essays 26 to 29: "I Need Help", "Around, Not Up", "How AI Saved Me", and "How Partying Can Save Us"
- Add essays and interstitials exploring community, culture, and the impact of AI
- Add essays on human trust, community support, and AI's role in expression
- fix essay statuses — sync sequence with repo (3-5 POSTED, 6 POSTED today)
- add vibe-coding Stripe exploit to essay 23 — real-world case study, $87,500 in fraud

## February 28, 2026

- restructure appendices as sequential post-finale, add Appendix 5: AI Governs Itself (stub)
- fix sequence + book structure — How to Save the World by Partying is the finale, Good Times Gang is interstitial
- draft Appendix 4: How We Fix Voting — trust graph governance, weighted participation, verifiable outcomes
- add BOOK.md — How to Save the World by Partying
- draft Appendix 3: The New Rules — AI regulated by human trust, not institutional authority
- add Appendix 3: The New Rules to essay 14 in sequence
- add DOCUSERIES.md — production bible for the imajin docuseries
- add interstitial essays to sequence — Cult of Community, Save the World by Partying
- add file numbering note to sequence
- update master sequence — full restructure with 25 essays + standalones
- add Thaler v. Perlmutter reference to essay 24 stub
- add essays 22, 23, 24 (stub) to articles folder

## February 27, 2026

- fix: only show POSTED articles in list
- feat: add prologue to articles list
- fix: update subtitles and descriptions for clarity in prologue and guild essays
- feat: add learn app to monorepo (#53)
- fix: UI audit items — invite gate, www CTA (#47)
- feat(profile): add email & phone contact fields (#52)
- fix: coffee auth import + dykil Suspense boundary for useSearchParams
- feat(dykil): build survey/poll platform with form engine and builder UI
- feat(coffee): migrate app to monorepo with cookie auth and @imajin packages
- feat(links): polish app with NavBar, dashboard, and auto-create
- feat: add links service to monorepo (migrated from standalone repo)
- feat: include role from metadata in session response
- fix: update prologue title and description for clarity
- Add 'event' type to trust_pods schema
- fix: add presence type to profile display
- fix: article typography plugin + essay 4/5 status to POSTED
- feat: profile trust gating — only connections can view full profiles (#49)
- fix: connections disconnect route imports
- feat: NavBar simplification (#48), profile redirect (#50), disconnect button (#49)
- fix: clean up old avatars on upload, add cache busting
- feat: client-side image resize to 256x256 JPEG 80% before upload
- fix: Avatar renders blob: URLs as images for upload preview
- fix: profile auth uses session cookie instead of Bearer token (#42)
- feat: add Download Backup Keys button to profile edit page (#46)
- fix: add Suspense boundary to profile register page for useSearchParams
- fix: pass invite code through profile register flow
- fix: connections Message links to /start?did= server route
- fix: resolve handles server-side in connections API
- fix: add name to Connection interface
- fix: resolve handles on connections list, show DID on hover
- fix: remove duplicate profileUrl declaration
- fix: all login links point to profile/login instead of auth/login
- feat: connections list Message button + CORS on connections API

## February 26, 2026

- fix: redirect to connections after invite registration, not back to invite page
- fix: add OPTIONS preflight handler for invite CORS
- fix: CORS headers on invite GET for cross-subdomain validation
- fix: wrap register page useSearchParams in Suspense boundary
- feat: invite-only registration (#40)
- fix: invite page detects login state, role-based invite limits
- fix: add darkMode class to connections tailwind config
- fix: CORS on auth session/logout for cross-subdomain NavBar identity
- feat: NavBar auto-fetches identity from auth service when no prop provided
- refactor: profile NavBar uses @imajin/ui with identity prop
- feat: connections UI, invite flow, navbar update
- fix: correct drizzle schema path for connections
- feat: add connections service and trust-graph package
- fix: use Web Crypto extractable keys to properly derive EdDSA public key for jose
- fix: derive public key from PKCS8 via SPKI for JWT verification
- fix: use Web Crypto API for extractable key pair (EdDSA JWT signing+verification)
- fix: type assertion for importJWK return
- fix: proper JWK public key extraction for verification
- fix: use public key for JWT verification (EdDSA requires it)
- fix: clear stale localStorage when auth session returns 401
- fix: use --no-frozen-lockfile in deploy (server workspace includes standalone repos)
- ci: add workflow_dispatch trigger, set DATABASE_URL secret
- fix: remove typecheck step from CI (next build handles it)
- fix: update lockfile, deploy only after CI passes (workflow_run)
- fix: remove eslint 10 override from profile (use root eslint 8)
- fix: correct auth session route db imports (@/db → @/src/db)
- fix: use git reset --hard in deploy workflows to handle dirty state
- ci: fix runner label to self-hosted
- fix: verify identity exists in DB before trusting session JWT
- ci: add dev and prod deploy workflows via self-hosted runner
- feat: migrate from Neon to local Postgres via @imajin/db
- Add initial documents for Imajin and MJN protocol
- feat: shared NavBar, dark theme, auth flow fixes, search by handle

## February 25, 2026

- feat: environment-aware service URLs via NEXT_PUBLIC_SERVICE_PREFIX + NEXT_PUBLIC_DOMAIN
- feat: identity context, handle check, login/recovery, edit profile, nav awareness

## February 24, 2026

- revert: remove password manager hack, keep for passkey phase
- feat: Save to Password Manager button using Credential Management API + fallback
- feat: copyable DID + password manager save prompt on registration success
- fix: use randomSecretKey (noble/ed25519 v3 API)
- fix: tsconfig ES2020 target for BigInt, fix base58 modulo (58 not 61)
- feat: profile registration flow - /register, /api/register, /[handle] profile pages
- style: normalize pay landing page with dark mode support
- feat: add Pay to navbar, normalize pay layout
- Refactor titles and statuses in articles for clarity and consistency

## February 23, 2026

- Add RFCs for .fair Attribution and Programmable Distribution Contracts; establish foundational protocols for contributor attribution and value routing in the imajin network.
- Revise publication dates and statuses for articles; enhance content in "The Guild" and "The Utility" articles to clarify community dynamics and trust graph benefits.
- Add section on bad actors and network integrity to "The Utility" article
- Remove all invitedBy references from profile app
- Remove invitedBy from profile route (moved to connections)
- Fix profile db import paths
- Add target es2017 to tsconfig
- Revise language for clarity and consistency in "The Internet That Pays You Back" article
- Remove framework field, use pnpm next build

## February 22, 2026

- Add /health status page (Phase 1)
- Standardize vercel.json configs for pnpm monorepo
- Update status of essay-03 to 'POSTED'
- Remove titles from articles and update document history links to reflect new file paths
- Move articles to apps/www/articles (preserves history)
- Use node script for article copying with path debugging
- Copy articles at build time instead of duplicating
- Add subtitles to essays 3-20 from sequence summaries
- refactor: render articles from markdown files instead of hardcoded JSX
- fix: update mask article status to POSTED
- fix: escape curly apostrophes in article descriptions
- Add document history links to articles for better traceability

## February 21, 2026

- feat: add AI crawler infrastructure
- feat(articles): sync essays 4 & 6 with expanded content
- feat(essays): expand on the role of bad actors and community accountability in the network structure
- fix(articles): update essays 1 & 2 to match latest edits
- feat(articles): add all 20 essay pages with status badges
- fix: clarify timeline of travel experience in essay-03-the-mask-we-all-wear
- fix(articles): update year in article title and references from 1985 to 1988
- feat(essays): add new essay on the importance of asking for help and expand on the role of connectors
- Add essays on the business case for human trust, attribution infrastructure, and the need for community support
- feat(auth): integrated auth flow with JWT sessions
- fix(registry): add vercel.json for registry service

## February 20, 2026

- feat(profile): add key export with clear sovereignty warning
- feat(profile): add soft registration and claim flow
- feat(profile): update data model per #6
- feat(www): add OG/Twitter metadata to article pages
- feat(profile): add dynamic OG/Twitter metadata for profile pages
- docs: add DEPLOYMENT.md with monorepo deployment guide
- chore(registry): remove vercel.json for dashboard config
- fix(registry): add vercel.json with monorepo build commands
- fix(registry): revert to workspace deps for monorepo deployment
- fix(registry): simplify vercel.json for standalone deployment
- fix(registry): inline auth module for standalone deployment
- fix(registry): switch to Neon serverless for better memory usage
- fix: Next.js 14 async params for profile/registry routes
- feat: add shared navigation bar to all services
- feat: add OG/Twitter metadata to all services
- fix: use valid Stripe API version (2024-11-20.acacia)
- docs: mark pay service as live
- docs: update service status table with live deployments
- chore: add Vercel configs and update root dependencies
- chore(profile): add vercel config and gitignore
- feat(auth): define 6 identity types in types.ts
- feat(registry): add Tailwind and unify landing page styling
- feat(auth): expand identity types and update landing page

## February 19, 2026

- Add HTML pages for new articles, fix mobile font scaling
- Add articles on AI development, trust graphs, and business models

## February 18, 2026

- feat: add coffee.imajin.ai support link to homepage
- fix: scale up logo and kanji to match 150% font increase
- feat: add second article page, articles landing, 150% font scale
- fix: update article publication details for clarity and consistency
- fix: lazy Stripe init in pay webhook for CI builds
- fix: lazy database initialization for CI builds
- fix: resolve TypeScript build errors in profile service
- chore: configure ESLint across all apps and packages
- fix(article): update phrasing for clarity in infrastructure description
- fix: disable lint scripts until eslint is configured
- www: add Discord link with self-aware note
- fix(article): clarify phrasing in "What I Actually Do" section and update author attribution
- article: add 386/40MB detail to BBS article
- article: fix origin story details
- article: add potato story + nuance on formal training
- article: replace personal essay with dev thesis
- fix(article): improve phrasing in "The Pain of Knowing" essay
- feat(article): add new essay "I'm Sorry I Couldn't Explain" and update existing content for clarity
- fix(article): correct capitalization of names and improve phrasing
- feat: pay service + webhook flow + public README

## February 17, 2026

- feat: add registration UI at /register
- docs: clean up README - split core vs external apps
- feat: expand identity types (human, agent, event, presence, org)
- feat: add tablesFilter to drizzle configs for monorepo schema isolation
- docs: add identity model spec (DIDs for everything that acts)
- Fix token metadata: use www URLs to avoid redirects
- Security: remove sensitive info before making repo public
- Add MJN token icon and metadata
- fix(article): correct capitalization and remove duplicate closing remarks
- feat: add deployment pipeline with environment isolation
- refactor: extract side apps to separate repos
- feat(article): add selective disclosure paragraph back
- feat(www): replace placeholder orbs with Imajin logos
- feat(article): full version with Hot Tamale story, metrics comparison, thirty years of pain
- fix(article): update author name in article footer
- fix(article): remove Mastodon comparison
- feat(article): add selective disclosure + Mastodon distinction
- feat(www): landing page + article 'The Internet We Lost'
- feat(www): add imajin.ai landing + register page

## February 16, 2026

- docs: add manifesto - The Internet We Lost

## February 15, 2026

- feat(links): scaffold link-in-bio service
- feat(coffee): scaffold tip/payment service

## February 14, 2026

- feat(profile): scaffold profile service
- docs: update build order - profile → coffee → links → chat → events
- refactor: merge tickets into events
- docs: add PROJECTS.md for all missing apps
- docs: rename connect→connections, clarify coffee (tips), add links app
- feat(registry): scaffold federated node registry for sovereign network

## February 13, 2026

- docs: update README with current project state
- feat: add pay package and service, wire Ed25519 crypto
- docs: update README with sovereign stack vision
- feat(auth): add sovereign identity package and service
- feat(dykil): implement community spending form with social groups

## February 12, 2026

- feat(karaoke): MVP turn management system
- Implement structural updates and refactor code for improved maintainability

## February 11, 2026

- Initial monorepo setup: dykil, learn, fixready, karaoke

