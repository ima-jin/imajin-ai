# Cookie isolation & scoped app tokens (#1069 Phase 2)

Status: **Phase 2 — host-only deployed default.** Phase 1 (#1974) shipped
scoped-token primitives; standalone coffee, dykil, links, learn, market,
events and the app template now use `requireSessionOrAppToken`. This phase
narrows the kernel browser session cookie, without changing token semantics
or removing the cookie fallback. Refs #1069; phases 3 and 4 remain open.

## Trust boundary

The session cookie is `imajin_session` in prod and `imajin_session_dev` in
dev, with a 24-hour TTL. In deployed mode the active cookie has **no Domain
attribute**, `Path=/`, `HttpOnly`, `Secure`, and the existing `SameSite=None`.
Omitting Domain (not setting it to a hostname) makes it host-only.

- **Inside:** the exact kernel browser host for that environment:
  `jin.imajin.ai` (prod) or `dev-jin.imajin.ai` (dev), with kernel services
  path-prefixed under `/auth`, `/profile`, `/pay`, `/connections`, `/registry`,
  `/chat`, `/media`, `/notify`, etc.
- **Outside:** every other host, including the opposite environment,
  `fixready.imajin.ai`, `karaoke.imajin.ai`, scorecard, preview/forgotten
  subdomains, and the apex. Browsers do not send the newly written active
  session cookie there. HttpOnly prevents JavaScript reads, but did not stop
  a parent-domain cookie reaching other subdomains' servers.
- **Not isolated yet:** userspace processes reverse-proxied onto the SAME
  origin, e.g. `jin.imajin.ai/coffee` or `/events`. Host-only cookies still
  reach those routes through Caddy. A scoped-token adapter does not prevent
  the proxy from forwarding the raw Cookie header. **Phase 3 must strip
  Cookie on app routes in Caddy or design a suitable cookie Path boundary.**

### Repository hostname audit

`apps/kernel/.env.example` defines one public origin (`APP_URL`,
`NEXT_PUBLIC_BASE_URL`), a full-origin `NEXT_PUBLIC_SERVICE_PREFIX`, and
same-host `NEXT_PUBLIC_*_URL` paths. Operators replace `your-node.imajin.ai`
with `jin.imajin.ai` or `dev-jin.imajin.ai` consistently, not `auth.imajin.ai`.
Core login/session UI uses relative `/auth` paths. Email verification and
its default events landing use the trusted runtime public origin; post-claim
attestations use the node origin. JWT issuer `auth.imajin.ai` is an identifier,
not a browser redirect, and is unchanged.

`deploy/ecosystem.dev.config.js` owns `dev-jin:3000`;
`deploy/ecosystem.prod.config.js` owns `prod-jin:7000`. Its old split-service
entries are documented drift, not proof those vhosts are required:
`deploy/README.md` ("Ecosystem config drift") documents one kernel process
behind path routing. `docs/ENVIRONMENTS.md` now records the same boundary.
The separate MCP discovery host does not need the session: `/oauth/authorize`
anchors browser login/consent to the configured kernel origin, and callbacks
carry OAuth code/state. Internal service URLs and explicit server-to-server
Cookie forwarding are not browser cross-host cookie dependencies.

No required kernel flow was found relying on browser cookies reaching a
different host under this configured topology. Keep APP_URL and client public
URLs consistent: shared navbar/builders retain legacy subdomain fallbacks if
required public env settings are missing. Live `.env.local`, DNS, registry
entries and `/etc/caddy/Caddyfile` are outside this repo and were not inspected.

## Host / path audit

| Host / path | Process | Boundary / follow-up |
|---|---|---|
| `jin.imajin.ai`, kernel paths | `prod-jin` (7000) | Host-only prod session |
| `dev-jin.imajin.ai`, kernel paths | `dev-jin` (3000) | Independent host-only dev session |
| `/coffee`, `/dykil`, `/links`, `/learn`, `/market`, `/events` on either kernel origin | Standalone userspace repos/processes | SAME host: still receives Cookie until phase 3; events' historical 3006/7006 port does not confer kernel trust |
| `fixready.imajin.ai` | Separate repo, 3400/7400 | Outside new cookie scope; app auth audit remains external |
| `karaoke.imajin.ai` | Separate repo, 3401/7401 | Outside new cookie scope; app auth audit remains external |
| scorecard | Separate repo, prod 7402 | Host inventory undocumented; outside cookie scope if a different host |
| `www`, apex, other/preview/forgotten subdomains | Not fully inventoried here | Outside new cookie scope; live DNS/Caddy inventory remains ops work |

## `SESSION_COOKIE_SCOPE` and rollback

`packages/config/src/session.ts` is the options source of truth:

- **Unset (default)**, `host` (accepted compatibility alias), or an unknown
  value: host-only deployed cookie, no Domain attribute.
- **`SESSION_COOKIE_SCOPE=domain`**: restores legacy `Domain=.imajin.ai`
  options and active-cookie serialization byte-for-byte. This deliberately
  reopens cross-subdomain exposure; use only as the reversible rollback.
- Localhost detection/attributes are unchanged: no Domain, not Secure,
  `SameSite=Lax`, `HttpOnly`, `Path=/`, same names and TTL.

The rollback setting belongs on the **kernel process**, not every app.
Set it in the kernel process environment and restart/redeploy through the
normal approved workflow (prod-jin or dev-jin); no database migration or
signing-key rotation. The next session write issues a domain cookie and
expires a leftover host-only cookie, so rollback does not leave ambiguous
same-name credentials. Unset it to return to the secure default.

## Deploy / legacy-cookie coexistence

**No mass logout.** Deploy changes issuance, not verification or JWT keys.
A browser holding only the legacy Domain cookie still sends it to the kernel
host and remains authenticated. Read-only session requests do not reissue or
invalidate it. On the next login, refresh/reissue, registration, onboard claim
or other session write, the kernel writes a host-only cookie and expires the
legacy `Domain=.imajin.ai; Path=/` cookie with the same environment-specific
name. Existing host-only + legacy duplicates converge to exactly one cookie.
Until that write (or the legacy cookie's normal expiry), the browser's old
parent-domain cookie can still reach other subdomains; this is staged migration,
not a claim that already-stored credentials vanish at deploy time.

All kernel session writes/clears use
`apps/kernel/src/lib/auth/session-cookie.ts` (`withSessionCookie`). It emits
separate Set-Cookie headers because Next.js's name-keyed response cookie map
cannot represent both domains. It finalizes the response **after all other
cookie mutations**, preserving e.g. `x-acting-as`. Logout (auth, connections,
and profile aliases) and invalid/missing-identity session responses expire
both scopes, so the old cookie cannot silently restore the session. Localhost
emits only its original local cookie. No JWT revocation semantics are changed.

## Scoped app token primitive

Two new endpoints, symmetrical to the existing third-party path
(`/auth/api/apps/token`), but keyed off the caller's own first-party
session instead of an app DID + attestation:

- `POST /auth/api/tokens/app` (`apps/kernel/app/auth/api/tokens/app/route.ts`)
  — caller must have a valid session cookie. Body: `{ aud, scopes? }`. Mints
  a ~10 minute EdDSA JWT (`createSessionAppToken`,
  `apps/kernel/src/lib/auth/jwt.ts`) with `sub` = the caller's DID, `aud` =
  the requested app audience (its registry slug, e.g. `coffee`), and `scope` = the requested scopes clamped to the
  `SCOPES` vocabulary. Refresh = call again with the (still-valid) session.
- `POST /auth/api/tokens/app/verify` — stateless verification: EdDSA
  signature, expiry, token type, and (when supplied) exact `aud` match, all
  checked locally with no DB hit.

**Update (#1990):** `aud` is no longer an arbitrary caller-supplied string.
Both the mint and verify routes now resolve it against `registry.apps`
(`token_audiences`, extended by `0138_registry_apps_registry_fields.sql`) and
require an ACTIVE, non-revoked row — an unregistered or revoked `aud` gets a
stable `403 { error: "app_not_registered" }` instead of a token. This makes
"no DB hit" apply only to the signature/expiry checks; the registry lookup is
a deliberate, documented exception for this route (unlike the third-party
`/auth/api/apps/token/verify` path below, which keeps its no-DB-hit
contract — see that route's own docblock for why). First-party apps
(coffee, dykil, links, learn, events, market, jin) are pre-registered with
their own scope id as both `token_audiences` and `allowed_redirect_hosts`.

`@imajin/auth` exports a verifier apps call directly:

```ts
import { verifyAppToken } from "@imajin/auth";

const claims = await verifyAppToken(bearerToken, { aud: "coffee" });
// claims: { sub, aud, scopes, actingAs? } | null
```

**Act-as (#2639, #2644):** `POST /auth/api/tokens/app` also accepts an optional `actAs` group
DID. The kernel runs the existing `validateActingAs` group-authority gate once, at mint, and only for
an app the operator approved for act-as (`registry.apps.act_as_allowed`, off by default); otherwise
`403` and no token. The token then carries an `acting_as` claim, `verifyAppToken` returns it as
`actingAs`, and `requireSessionOrAppToken` surfaces it as `auth.actingAs` on the `token` path. There
is no per-request group re-check; the 10-minute expiry bounds staleness, and verify stops accepting
the token if the app loses act-as approval. The `cookie` path is unchanged and never carries
`actingAs`. See `docs/REGISTRATION.md` ("Acting as a group DID").

This is a distinct token `typ` (`session-app+jwt`) from the third-party
`app+jwt` / `app-service+jwt` tokens — it carries no `azp` or
`attestationId`, and a verifier for one type will never accept the other
(see `apps/kernel/src/lib/auth/__tests__/session-app-token.test.ts`).

## App migration adapter

`requireSessionOrAppToken` (`packages/auth/src/require-session-or-app-token.ts`)
accepts **either** credential:

1. `Authorization: Bearer <token>` — verified via `verifyAppToken` against
   the app's own `aud` — its **registry slug**, never its host (#2706):
   path-routed apps share one host, so a host audience would make apps accept
   each other's tokens, and the registry only holds slugs. The audience is
   `IMAJIN_APP_AUD` when set, else the `slug` option. Authoritative for scopes
   (`requireScopes`). A bearer that doesn't verify is a 401 — it never falls
   back to the cookie.
2. Falls back to the legacy shared session cookie only when there is no bearer.

This lets an app move call sites to tokens one at a time, without a
synchronized flag day across every app and the kernel.

## Staged rollout

1. **Phase 1 — merged:** mint/verify endpoints and migration adapter (#1974),
   followed by standalone app adoption. Token path remains authoritative;
   invalid bearer tokens never fall back to cookies.
2. **Phase 2 — this change:** deploy the host-only default on the kernel;
   remove any `SESSION_COOKIE_SCOPE=domain` override when ready. Operators
   see uninterrupted legacy kernel sessions and dual Set-Cookie headers on
   the next session write: one live host-only credential, one expired domain
   credential. Verify prod and dev independently. Roll back with
   `SESSION_COOKIE_SCOPE=domain` on the kernel process as above. Do not rotate
   keys or force everyone to re-login. Apps on different hosts need scoped
   tokens; a legacy cookie is no longer an app authentication contract.
3. **Phase 3 — pending ops/Caddy or Path work:** isolate userspace apps
   proxied onto the kernel origin. This phase is NOT implemented here.
4. **Phase 4 — pending:** remove `requireSessionOrAppToken`'s cookie fallback
   only after all consumers and same-origin isolation are verified. Not part
   of this PR; #1069 remains open.

## Open follow-ups

- **Phase 3: same-origin path-app exposure.** Caddy stripping `Cookie` on app
  routes or a cookie Path design requires ops/Caddy work outside this repo.
- **Phase 4:** remove the legacy cookie fallback once adoption/isolation are
  complete; no token-path semantics are changed here.
- Live DNS/Caddy vhost inventory, including preview/forgotten subdomains;
  verify actual env origins and registered cross-host embed token handoffs.
- Audit fixready/karaoke/scorecard authentication in their own repositories.
- Production ecosystem obsolete split-service entries and public AssetDetail
  legacy profile-host fallback are routing/config debt, not evidence of a
  required cross-host kernel sign-in ceremony; coordinate cleanup separately.
- In-process JWKS verification and proof-of-possession nonce single-use remain
  separate work. No schema, ops config, app repos or signing keys changed.
