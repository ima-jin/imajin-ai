# Cookie isolation & scoped app tokens (#1069 Phase 1)

Status: **Phase 1 — primitives only.** Everything in this document is
opt-in and off by default. No app's default authentication behavior changes
as a result of the code that ships alongside this doc. Flipping any of the
flags described here is a separate, later, human-run phase — see
[Staged rollout](#staged-rollout).

## Problem recap

`getSessionCookieOptions()` (`packages/config/src/session.ts`) sets
`domain: ".imajin.ai"` on the deployed session cookie. A cookie with a
leading-dot domain is sent by the browser to **every** host under
`*.imajin.ai` — not just the kernel. Any service that can read the incoming
`Cookie` header (whether because it lives on a real `*.imajin.ai` subdomain,
or because it's reverse-proxied onto the same origin as the kernel) receives
the same session credential the kernel itself trusts, with no scoping. See
issue #1069 for the full background and prior audit findings (#1248, #1800
class of findings).

## Two existing auth paths

- **Path A — session cookie (first-party).** `imajin_session` JWT, currently
  `domain=.imajin.ai`, 24h TTL, full-account. This is the path this document
  is about narrowing.
- **Path B — app DID auth (third-party).** `requireAppAuth()` /
  `POST /auth/api/apps/token` — an app with a user's `app.authorized`
  attestation mints a short-lived, scoped JWT (`apps/kernel/src/lib/auth/jwt.ts`:
  `createAppToken` / `verifyAppToken`). This already exists (#1071, merged) and
  is unaffected by this phase.

This phase adds the missing **first-party** counterpart to Path B — see
[Scoped app token primitive](#scoped-app-token-primitive) — so first-party
apps have somewhere to go once the shared cookie is narrowed.

## Subdomain / host audit

This repo does not contain the live Caddy config (`/etc/caddy/Caddyfile`
lives on the ops server, per `docs/ENVIRONMENTS.md`), so the exact live
routing topology **cannot be fully verified from this repo alone** — see
the honest-unknowns callout below. The table is built from
`deploy/ecosystem.prod.config.js` (what actually runs as separate
processes), `docs/ENVIRONMENTS.md`, and `docs/developer-guide.md`.

| Host / path | Backing process (port) | Classification | Notes |
|---|---|---|---|
| `jin.imajin.ai` (`auth`, `pay`, `profile`, `connections`, `registry`, `chat`, `media`, `notify` — via subdomains per ENVIRONMENTS.md, or paths per developer-guide.md) | `prod-jin` (7000) | Kernel-authenticated | One Next.js process (RFC-19). This is the trusted core the session cookie exists to authenticate. |
| `jin.imajin.ai/events` (or `events.imajin.ai`) | `prod-events` (7006) | **Ambiguous — see below** | `ENVIRONMENTS.md` lists it under the "Core" port tier; RFC-19 explicitly lists `events` under "What's NOT in the kernel" (userspace). Treat as userspace (lower trust) until confirmed otherwise. |
| `jin.imajin.ai/coffee` | `prod-coffee` (7100) | Userspace app | Tipping/support pages. Chosen as the Phase 1 reference app (low risk, small surface). |
| `jin.imajin.ai/dykil` | `prod-dykil` (7101) | Userspace app | Community spending surveys. |
| `jin.imajin.ai/links` | `prod-links` (7102) | Userspace app | Link-in-bio pages. |
| `jin.imajin.ai/learn` | `prod-learn` (7103) | Userspace app | Courses/enrollment. |
| `jin.imajin.ai/market` | `prod-market` (7104) | Userspace app | Local commerce. |
| `fixready.imajin.ai` | `prod-fixready` (7400) | **Unknown** | Separate repo (`imajin-fixready`), not in this monorepo — cannot audit its auth code from here. Has its own database, per `ENVIRONMENTS.md`. |
| `karaoke.imajin.ai` | `prod-karaoke` (7401) | **Unknown** | Same as fixready — separate repo (`imajin-karaoke`), own database, not auditable from this repo. |
| `scorecard...` (`prod-scorecard`, port 7402) | `prod-scorecard` | **Unknown / undocumented** | Present in `ecosystem.prod.config.js` but absent from `ENVIRONMENTS.md`'s service table and `developer-guide.md`'s service list entirely. No hostname or trust classification documented anywhere in this repo. |
| `www` / `imajin.ai` (root) | — | Kernel-adjacent (public, unauthenticated) | Landing page — `developer-guide.md` lists it at the bare root domain, not under `jin.`. Not itself a cookie consumer as far as this audit can tell, but shares the root domain the wildcard cookie's `.imajin.ai` scope also covers. |
| Any other/forgotten/preview subdomain | — | **Unknown** | No inventory of live DNS records or Caddy vhosts exists in this repo. This is exactly the "forgotten/preview subdomain" risk #1069 calls out, and it cannot be closed by a code change alone — it requires an operator-side DNS/Caddy inventory pass, tracked as a follow-up (see [Open follow-ups](#open-follow-ups)). |

### Honest unknowns

1. **Routing topology conflict, tentatively resolved in favor of
   path-based.** `docs/ENVIRONMENTS.md`'s "Domain" column describes
   kernel-only real subdomains (`auth.imajin.ai`, `pay.imajin.ai`, etc.)
   alongside **path**-based routing for the imajin-tier apps
   (`jin.imajin.ai/coffee`) — an internally inconsistent split. But
   `apps/kernel/.env.example`'s own `NEXT_PUBLIC_*` conventions
   (`NEXT_PUBLIC_AUTH_URL=https://your-node.imajin.ai/auth`,
   `NEXT_PUBLIC_COFFEE_URL=https://your-node.imajin.ai/coffee`, etc. — every
   one of them a path on the *same* `your-node.imajin.ai` host, never a
   distinct subdomain) line up with `docs/developer-guide.md` and
   `docs/rfcs/RFC-19-kernel-userspace-architecture.md` (status: **Draft**):
   one origin, everything else a path. That is stronger, code-level
   evidence than either doc alone, so treat path-based-under-one-origin as
   the more likely live model — but it is still not a substitute for
   reading the actual Caddyfile on the ops server, which this repo does not
   contain, so it cannot be fully confirmed here.
2. **It doesn't change the conclusion either way.** If the imajin-tier apps
   (`coffee`, `dykil`, `links`, `learn`, `market`, `events`) are reached via
   real subdomains, the wildcard `.imajin.ai` cookie is directly readable by
   their backend process. If instead they're reverse-proxied as **paths** on
   the same origin as the kernel, the cookie is same-origin and the browser
   sends it regardless of the `domain` attribute — a compromised app
   process still receives the raw session cookie on every request Caddy
   proxies to it. Either way, a compromised or vulnerable app backend gets
   the same full-trust credential the kernel uses for itself. This is why
   the fix is a token primitive the app must actively request and that is
   bound to its own audience, not just a narrower cookie `domain` attribute.
3. **`events`'s classification is internally contradictory** in this
   repo's own docs (see table above) and needs a human call before Phase 2
   routing decisions are made for it.
4. **`fixready`, `karaoke`, and the undocumented `scorecard` app** live
   outside this monorepo or are simply undocumented; their cookie handling
   cannot be audited here and must be checked directly against their own
   repos/configs before they're assumed either safe or unsafe.

## `SESSION_COOKIE_SCOPE` flag

`packages/config/src/session.ts` — `getSessionCookieOptions()`:

- Unset, or any value other than `"host"` (**default**): unchanged —
  `domain: ".imajin.ai"` in deployed mode, exactly as today.
- `SESSION_COOKIE_SCOPE=host`: the deployed cookie omits `domain` entirely,
  making it host-only. It is then only ever sent back to the exact host
  that set it — no `*.imajin.ai` subdomain, and no path-proxied app on a
  different backend process, can read it.

This is a per-process env var. Because most services in the current
topology are separate pm2 processes with independent `.env.local` files
(see the audit table above), flipping it is **not** a single global switch —
each app that reads `SESSION_COOKIE_SCOPE` for its own opt-in behavior
(see the reference adoption below) needs it set in its own environment too.

## Scoped app token primitive

Two new endpoints, symmetrical to the existing third-party path
(`/auth/api/apps/token`), but keyed off the caller's own first-party
session instead of an app DID + attestation:

- `POST /auth/api/tokens/app` (`apps/kernel/app/auth/api/tokens/app/route.ts`)
  — caller must have a valid session cookie. Body: `{ aud, scopes? }`. Mints
  a ~10 minute EdDSA JWT (`createSessionAppToken`,
  `apps/kernel/src/lib/auth/jwt.ts`) with `sub` = the caller's DID, `aud` =
  the requested app host, and `scope` = the requested scopes clamped to the
  `SCOPES` vocabulary. Refresh = call again with the (still-valid) session.
- `POST /auth/api/tokens/app/verify` — stateless verification: EdDSA
  signature, expiry, token type, and (when supplied) exact `aud` match, all
  checked locally with no DB hit.

`@imajin/auth` exports a verifier apps call directly:

```ts
import { verifyAppToken } from "@imajin/auth";

const claims = await verifyAppToken(bearerToken, { aud: "coffee.imajin.ai" });
// claims: { sub, aud, scopes } | null
```

This is a distinct token `typ` (`session-app+jwt`) from the third-party
`app+jwt` / `app-service+jwt` tokens — it carries no `azp` or
`attestationId`, and a verifier for one type will never accept the other
(see `apps/kernel/src/lib/auth/__tests__/session-app-token.test.ts`).

## App migration adapter

`requireSessionOrAppToken` (`packages/auth/src/require-session-or-app-token.ts`)
accepts **either** credential:

1. `Authorization: Bearer <token>` — verified via `verifyAppToken` against
   the app's own `aud`. Authoritative for scopes (`requireScopes`).
2. Falls back to the legacy shared session cookie when there's no bearer, or
   the bearer doesn't verify as an app token.

This lets an app move call sites to tokens one at a time, without a
synchronized flag day across every app and the kernel.

### Reference adoption: `coffee`

`apps/coffee/app/api/pages/mine/route.ts` is the one app converted in this
PR, gated by the same `SESSION_COOKIE_SCOPE` flag:

- Flag unset (default): calls `requireAuth()` exactly as before. Zero
  behavior change.
- `SESSION_COOKIE_SCOPE=host` (in coffee's own environment): calls
  `requireSessionOrAppToken(request, { aud: <coffee's own host> })` instead.

No other app was touched. Every other app importing `@imajin/auth` keeps
calling `requireAuth()` / `getSession()` exactly as it does today — this PR
adds new exports, it does not change the behavior of existing ones.

## Staged rollout

Mirrors the design sketch on #1069. Each stage is independently reversible
by unsetting the env var(s) it introduces — no stage depends on a database
migration.

1. **Phase 1 (this PR).** Ship the mint/verify endpoints, the
   `SESSION_COOKIE_SCOPE` flag (default off), the adapter, and one reference
   app conversion (flag-gated, off by default). No app's default behavior
   changes. **Rollback:** revert the PR, or simply never set
   `SESSION_COOKIE_SCOPE`.
2. **Phase 2 — apps adopt the adapter.** Each userspace app converts its
   `requireAuth()` call sites to `requireSessionOrAppToken()`, still with
   `SESSION_COOKIE_SCOPE` unset (so the cookie fallback keeps working
   unchanged). Ship and verify one app at a time. **Rollback:** revert that
   app's call sites; the cookie was never narrowed, so there is no session
   impact.
3. **Phase 3 — flip the cookie scope.** Set `SESSION_COOKIE_SCOPE=host` on
   the kernel first, then on each app that has completed Phase 2, in the
   order the audit table above orders them by confidence (kernel's own
   domains → coffee/dykil/links/learn/market → events, once its
   classification is resolved → fixready/karaoke/scorecard, once audited).
   Expect a brief forced re-login window for any user whose browser had
   only ever held the old wildcard cookie the moment their next request
   lands on a host that no longer receives it. **Rollback:** unset
   `SESSION_COOKIE_SCOPE` on the affected process(es) — the cookie
   immediately reverts to `.imajin.ai` scope on that process's next
   response, no data loss, no migration to undo.
4. **Phase 4 — remove the legacy path.** Once every app is confirmed on the
   token path and the cookie is host-scoped everywhere, remove the cookie
   fallback from `requireSessionOrAppToken` (or delete it in favor of calling
   `verifyAppToken` directly) and delete this doc's "default off" caveats.
   **Rollback:** effectively none needed — this stage is deleting dead code,
   not changing runtime behavior, so it can be delayed indefinitely without
   risk.

## Open follow-ups

Explicitly out of scope for this PR, tracked here rather than lost:

- Live DNS/Caddy vhost inventory to close the "forgotten/preview subdomain"
  unknown (needs ops-server access, not just this repo).
- Resolving whether `events` is kernel or userspace, and updating
  `docs/ENVIRONMENTS.md` / `docs/developer-guide.md` / RFC-19 to agree.
- Auditing `fixready`, `karaoke`, and `scorecard` (separate repos / entirely
  undocumented) for how they consume the session cookie today.
- Moving `verifyAppToken` fully in-process (kernel public key published via
  JWKS, verified with `jose` directly in `@imajin/auth`) to drop the verify
  round-trip — same follow-up already noted against the third-party path in
  PR #1071.
- Proof-of-possession / nonce single-use enforcement, if the session-app
  token mint ever grows a PoP step (it doesn't need one today: it's minted
  from an already-authenticated session, not a bearer credential presented
  by an untrusted party).
