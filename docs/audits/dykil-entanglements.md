# Dykil — entanglement audit and gap classification

Refs #2519 (step 1 of 5) · Part of #1985 · Source audit: #1983 · Epic: #1981

This document classifies every way `apps/dykil` is entangled with the kernel monorepo.
Each entanglement is either:

- **(a)** replaced by a public-contract call (scoped app token, published `@ima-jin/*` SDK,
  documented kernel API, or removed outright), or
- **(b)** a kernel gap with a filed issue that blocks #2519 until the kernel exposes it.

The primitive mapping (which surface becomes a signed doc, an attestation, or a gate) is in
[`dykil-primitive-mapping.md`](./dykil-primitive-mapping.md).

Method: static reading of all source files under `apps/dykil/app` and `apps/dykil/src`, a grep of the rest of the monorepo for
`dykil`, the `#1983` audit comment, `migrations/*`, the published `@ima-jin/*` npm tarballs, and
the already-rebuilt `ima-jin/dykil` repo. Nothing was built or run.

## What the #1983 audit missed

#1983 scored dykil **0** (no internal imports, no cross-schema SQL, no internal routes). That
number is correct for the one direction it measured: `apps/dykil` calling the kernel. It does not
capture two things:

1. **The shared package and database layer.** `apps/dykil` is entangled through `workspace:*`
   packages (`@imajin/auth`, `db`, `logger`, `config`, `ui`), the shared `DATABASE_URL`, the shared
   root `/migrations`, and a kernel-internal API key fetched at boot. None of that is a source
   import of `apps/kernel/src/**`, so it scored 0.
2. **The reverse direction.** `apps/events` reads `dykil.survey_responses` and `dykil.surveys`
   with raw SQL in 9 files (10 entries in `migrations/cross-schema-allowlist.json`). Dykil cannot
   leave the shared database (steps 4 and 5) while another app reads its tables.

Effective entanglement for dykil is therefore not 0. The extraction order (links → dykil) is
unaffected, but dykil is blocked on events-side work that the audit scored under events.

## Forward entanglements (`apps/dykil` → kernel / monorepo)

| # | Entanglement | Evidence | Class | Replacement or issue |
|---|---|---|---|---|
| F1 | Cookie auth via `@imajin/auth` `requireAuth` / `getSession` on every route | `app/api/surveys/**`; `getSession` in `respond` and `responses/check` | (a) | `requireSessionOrAppToken` from published `@ima-jin/auth` behind one `authenticate()` (done in `ima-jin/dykil`). `/api/session` is a public route. Optional-auth `getSession` for guests has no replacement: see F13 |
| F2 | `X-Acting-For` scope switch via `resolveActingDid`, transitively calling undocumented `/api/internal/verify-delegation` | every authenticated route | (a) | #1995 (closed) documented the contract; `@ima-jin/auth` carries it |
| F3 | `bootstrapInternalApiKey('dykil')` fetches the vault-sourced kernel-internal `ATTESTATION_INTERNAL_API_KEY` | `instrumentation.ts` | (a) | Removed. App identity comes from registration + `loadAppSigningKey()` (#1990, #2411). A third-party app never holds a kernel-internal key |
| F4 | Shared Postgres: `@imajin/db` `createDb`, `DATABASE_URL`, `dykil` schema (2 tables) | `src/db/*`, `drizzle.config.ts` | (a) | App owns no tables (ruling DECISION #1985→c). Surveys are signed docs, responses are attestations. Existing rows move by the node-witnessed import (step 4, #2522). Table disposition in the mapping doc |
| F5 | `drizzle.config.ts` imports monorepo-relative `../../scripts/env-utils.js` | `drizzle.config.ts` | (a) | Removed with the schema |
| F6 | `createAppHealthHandler` from `@imajin/db` | `app/api/health/route.ts` | (a) | App-local health route (no DB to check) |
| F7 | `@imajin/logger/db` registers a DB sink that writes to kernel `registry.logs` | `instrumentation.ts` | (a) | stdout logging only; published `@ima-jin/logger` root has no DB dependency (#2143) |
| F8 | `@imajin/config`: `apiFetch`, `apiUrl`, `buildPublicUrl`, `corsHeaders`, `corsOptions`, tier-2/3 headers, `APP_DISPLAY_NAME`, `standaloneDashboardMiddleware` | `app/**`, `middleware.ts`, `next.config.js` | (a) | `@ima-jin/config@0.8.0` exports the first six (checked in the tarball). `APP_DISPLAY_NAME` becomes a local constant. `standaloneDashboardMiddleware` (hub redirect, #2332) is not published and is not carried over; hub navigation comes from registry nav metadata (#2425, `0167`). Verify hub embedding in step 3 |
| F9 | `@imajin/ui`: `NavBar`, `ImajinFooter`, `ToastProvider`, `useToast`, `@imajin/ui/server` `buildServiceMetadata`, `defaultViewport` | `app/layout.tsx`, `app/providers.tsx`, pages | (a) | `@ima-jin/ui@0.8.0` exports all six (checked in the tarball). The rebuilt repo has no pages yet: UI parity is step 2 (#2521) |
| F10 | Derived kernel URLs: `NEXT_PUBLIC_SERVICE_PREFIX`, `NEXT_PUBLIC_DOMAIN`, `AUTH_URL`, `NEXT_PUBLIC_BASE_PATH`, literal `dykil.imajin.ai` | `app/(chrome)/layout.tsx`, `page.tsx`, `dashboard/page.tsx` | (a) | Env contract in `ima-jin/dykil` `.env.example` (`IMAJIN_KERNEL_URL`, `AUTH_SERVICE_URL`, `MEDIA_SERVICE_URL`); `basePath: '/dykil'` kept for the Caddy slot |
| F11 | Framing headers: the `(bare)/embed/[surveyId]` route is iframed by the events survey accordion | `next.config.js` | (a) | `@ima-jin/config/next-headers`; the embed route must allow the events origin explicitly. Step 2 |
| F12 | Shared root `/migrations`: `0001_seed.sql`, `0008`, and historical `0025`/`0026` that join `events.*`; ownership map lists 2 dykil tables | `migrations/*`, `ownership.json`, `OWNERSHIP.md` | (a) | Step 3 migration baseline and #1991 per-owner runner (#2524, #2526). `0025`/`0026` are historical and never re-run |
| F13 | Anonymous responses: `respondent_did` nullable, `respond` works with no session, `allowAnonymous`, `localStorage` `responseId` | `respond/route.ts`, `embed/[surveyId]/page.tsx` | **(b)** | **#2536** |

## Reverse entanglements (others → dykil)

| # | Entanglement | Evidence | Class | Replacement or issue |
|---|---|---|---|---|
| R1 | `apps/events` raw SQL on `dykil.survey_responses` / `dykil.surveys`, keyed by `ticket_id`: guest list, guest CSV export, sales export, registration, resend-email, refund, `/api/register/{ticketId}`, `guest-export-helpers.ts` | `migrations/cross-schema-allowlist.json` (10 entries) | **(b)** | Needs an indexed app reference on attestations (**#2534**), `context_id` filter (**#2396**), and pagination (**#2533**). Events-side rewrite is tracked by #1988. Blocks #2523 |
| R2 | Ticket-scoped survey gating: today `by-ticket/[ticketId]` plus `ticket_id` column | `responses/by-ticket/[ticketId]/route.ts` | **(b)** | Boolean ticket-holder gate (**#2395**). Dykil never reads ticket rows |
| R3 | Events → dykil HTTP: `GET /api/surveys/mine?dids=`, `GET /api/surveys/:id`, `GET /api/surveys/:id/responses/check` (browser, with cookie, and server-to-server with `?did=`), iframe `/embed/:id` + `postMessage('survey-completed')` | `apps/events/app/e/[eventId]/**` | (a) | Dykil's own documented HTTP API (`/api/spec`) is the contract. Cross-host browser calls use a scoped app token, not the shared cookie. The unauthenticated `check?did=` lookup is replaced by an authenticated caller or token |
| R4 | `events.registration_form_id` stores a legacy dykil survey id (`survey_…`) | `apps/events/src/db/schema.ts:103` | (a) | Rebuilt survey ids are media asset ids. Step 4 must re-point `registration_form_id` (events-owned column) or alias legacy ids; add to #2522 |
| R5 | Kernel names dykil by slug: health route lists (`api/health`, `api/admin/services/health`), `.well-known/assetlinks.json`, `apple-app-site-association`, `IdentityTabBar`, `feature-toggles-compat` (`LEGACY_APP_SLUGS`), profile `dykil` handle field and edit page, `auth/lib/service-registry.ts`, admin logs colours, `.env.example` (`DYKIL_SERVICE_URL`, `NEXT_PUBLIC_DYKIL_URL`), `deploy-prod.yml` comment | grep of `apps/kernel/**` | (a) | Registry-driven navigation (#2424/#2425). Pruned in step 5 (#2523) |
| R6 | Registry row `app_first_party_dykil` with a placeholder DID/key and `slug IS NULL` reserved for the extracted app | `0139`, `0163`, `0167` | (a) | Step 3 claims it through `apps.provision`; step 5 decides the placeholder row |

## Kernel gaps (class b) — all blockers of #2519

| Issue | Gap | Needed by |
|---|---|---|
| #2395 | No public boolean ticket-holder gate for third-party apps | R2, ticket-scoped surveys |
| #2396 | `GET /api/attestations` has no `context_id` filter | owner response listing |
| #2397 | No public handle-to-DID resolver | `/api/surveys/handle/:handle` (already a stub in `apps/dykil`) |
| #2533 | `GET /api/attestations` has no pagination | owner response listing and export |
| #2534 | Attestations have no indexed app reference (e.g. `ticketId`) | R1 |
| #2535 | Media asset access level can't change after creation | draft vs published privacy |
| #2536 | No anonymous or guest respondent path for attestations | F13 (`allowAnonymous`) |

Prerequisite gaps already resolved (verify in step 2): #2393 (media routes accept scoped app
tokens), #2394 (delegated respondent-signed attestations), #1992 (`@imajin/auth` no DB access),
#1993 (app-token routes documented), #1995 (verify-delegation documented), #2143 (logger DB sink
split), #2411 (vault-held signing key), #1990 (app registry).

## Findings for step 2 (defects in the rebuilt repo, not kernel gaps)

These come from reading `ima-jin/dykil` against the kernel on `main`. They are posted to #2521.

1. **Attestation reads send no credential.** `src/lib/kernel/attestations.ts` `listAttestations`
   calls `GET /api/attestations` with no `Authorization` header. Response types are registered
   third-party types, which the kernel gates with `disclosure_scope` (default `parties`;
   `apps/kernel/app/auth/api/attestations/route.ts`, `filterVisibleRows`). An anonymous list
   therefore returns no response rows, so the owner listing and `responses/check?ticketId=` return
   empty against a real kernel. The caller's token must be forwarded.
2. **Pagination loop never advances** until #2533 lands: the loop re-requests the same page.
3. **No UI.** The rebuilt repo has only `app/page.tsx`. The original has create, dashboard,
   results, respond, handle and embed pages. The embed page's `postMessage` protocol with events
   must be preserved.
4. **Authorization in `apps/dykil` `GET /api/surveys/mine?dids=`.** The comment says the caller
   must be one of the DIDs, but the code adds the caller to the list instead of checking, so any
   authenticated user can list any DID's surveys, including drafts. It must not be carried over;
   the rebuilt listing is by the caller's own DID only.
5. **`responses/check?did=` is unauthenticated** in `apps/dykil` and lets anyone probe whether a
   DID responded. Not carried over.
