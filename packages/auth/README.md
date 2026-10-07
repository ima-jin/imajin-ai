# @ima-jin/auth

DID-based identity, session, and app-token auth for Imajin services —
signing/verification, session and app-token middleware, scope grants, and
identity tiers.

## Install

```bash
npm install @ima-jin/auth
```

## Usage

```ts
import { requireAuth, authErrorResponse } from '@ima-jin/auth';
import { sign, verify } from '@ima-jin/auth';
import { requireSessionOrAppToken, requireHardDIDOrAppToken } from '@ima-jin/auth';
```

`requireSessionOrAppToken(request, { slug })` / `requireHardDIDOrAppToken(request, { slug })`
verify the Bearer token's `aud` against the app's **registry slug** (e.g.
`'dykil'`), never its host — path-routed apps share one host, and the registry's
`token_audiences` holds slugs. Set `IMAJIN_APP_AUD` to override the audience;
a host-shaped value is rejected. A Bearer that fails verification is a 401 — it
never falls back to the session cookie (#2706).

`requireHardDIDOrAppToken` is `requireSessionOrAppToken`
plus a hard-DID gate: soft (email-only) DIDs get a 403. Tier is read from the
session for cookie callers and looked up from the kernel's public
`GET /auth/api/identity/:did` for app-token callers — tokens carry no tier
claim. Only hard tiers are cached (30s); a soft result is never cached, so a
buyer who upgrades soft → hard succeeds on the next request.

Subpath exports are available for consumers that only need specific
vocabularies without pulling in the rest of the package:

```ts
import { BROKER_CONSENT_SCOPES } from '@ima-jin/auth/broker-consent-vocabulary';
import { SCOPES } from '@ima-jin/auth/scope-vocabulary';
import { GRANT_SCOPES } from '@ima-jin/auth/grant-scopes';
```

### Acting as a group DID

`requireSessionOrAppToken` returns `auth.actingAs` (the group DID) when the app token was minted
with `actAs`. The kernel checks the user's authority over the group once, at mint, and only for an
app the operator approved for act-as; there is no per-request re-check, and the token's expiry bounds
staleness. Own records as `auth.actingAs ?? auth.did`. The session-cookie fallback never sets it.

```ts
const result = await requireSessionOrAppToken(request, { slug: 'market' });
if ('error' in result) return new Response(result.error, { status: result.status });
const ownerDid = result.auth.actingAs ?? result.auth.did;
```

`validateActingAs` (the existing per-service group gate behind `requireAuth`'s `x-acting-as`
handling) is now exported for the kernel's mint-time check.

## What's included

- **Sessions** — cookie-based session issuance and validation
- **App tokens** — scoped tokens for registered third-party apps
- **Signing** — Ed25519 sign/verify helpers for DID-based identities
- **Identity tiers** — verified / established / steward / operator tier checks
- **Attestations** — emit and evaluate identity attestations

`@ima-jin/auth` depends on `@ima-jin/config` and `@ima-jin/logger` (both
published alongside it) and is DB-free — credential resolution happens
behind an internal kernel route rather than a direct database connection.

## Part of Imajin

[Imajin](https://imajin.ai) — sovereign technology infrastructure. Open source.
