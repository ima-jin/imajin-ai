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

### Agent delegation (`actingFor`)

`requireSessionOrAppToken` / `requireHardDIDOrAppToken` surface `auth.actingFor` (the owner DID) when
the request carries `X-Acting-For` **and** the delegation verifies — the same grants-first check
`requireAuth` runs (`/auth/api/internal/verify-delegation`, legacy membership fallback). `auth.did` is
the delegate. A delegation that does not verify is a 403, and the raw header is never surfaced. Feed it
to the delegation policy so a delegate is denied on irreversible routes:

```ts
import { enforceRoutePolicy } from '@ima-jin/auth/delegation-policy';

const { auth } = result;
const denied = enforceRoutePolicy({ id: auth.did, actingFor: auth.actingFor }, 'learn.course.delete');
if (denied) return denied;
```

The app's environment needs `AUTH_SERVICE_URL` and `AUTH_INTERNAL_API_KEY`; without them the check
fails closed (403) rather than trusting the header.

## What's included

### Verifying kernel webhooks (Node.js)

The helper below is the signed-verification contract for adopting receivers,
not the current behavior of every standalone app. Coffee/learn/market remain
Bearer-only until coffee#13/learn#15/market#15 merge and deploy; keep their
existing kernel callback Bearers until then. Events runs standalone in dev and
prod from [ima-jin/events](https://github.com/ima-jin/events); receiver and contact
integration now belong there, not to a kernel workspace app (#2517).
See [the per-app rollout and removal gate](../../docs/security/kernel-webhooks.md);
source pruning does not authorize removing shared public SDK/API surfaces.

The server-only `@ima-jin/auth/kernel-webhook` entry exports
`verifyKernelWebhook<T>(request, options)`, which authenticates the **raw request bytes**
before parsing JSON, returns the parsed body, and throws a `KernelWebhookError`
with a stable `code` on any failure. It consumes the request body; do not call
`request.json()` first. `T` is a TypeScript convenience, not runtime schema
validation: validate the returned event's application-specific shape.

```ts
import { verifyKernelWebhook, KernelWebhookError } from '@ima-jin/auth/kernel-webhook';

export async function POST(request: Request) {
  try {
    const event = await verifyKernelWebhook(request, {
      audience: 'did:imajin:example-app',
      authServiceUrl: 'https://kernel.example/auth',
    });
    // Validate event shape, then apply the event idempotently.
    return Response.json({ accepted: true });
  } catch (error) {
    if (error instanceof KernelWebhookError) {
      return Response.json({ error: 'Invalid kernel webhook' }, { status: 401 });
    }
    throw error;
  }
}
```

`audience` is required: pass the receiver's own registered app DID from its
keystore/identity configuration, never the inbound `x-kernel-audience`. That header
is signed and must match the configured DID; a delivery for another app fails with
`AUDIENCE_MISMATCH` before fetching keys or consuming a nonce.

`authServiceUrl` defaults to `AUTH_SERVICE_URL` and **already includes `/auth`**.
The SDK fetches `${authServiceUrl}/.well-known/kernel-signing-key` with a
5-second timeout and no redirects. Trusted key sets are cached by kernel URL and
pin-store identity for 60 seconds by default (`discoveryCacheTtlMs`; `0` disables).
Concurrent refreshes share one fetch. Unknown key IDs trigger a rate-limited
refresh; failed discovery attempts are also throttled. Expired caches do not
authorize callbacks after a discovery failure. Key validity is checked on every
request, so an expired grace key is rejected even within the cache TTL.
Remote discovery requires HTTPS. Loopback HTTP is allowed for development;
`allowInsecureHttp: true` explicitly permits remote HTTP on a separately
secured internal network, never a public network. First successful discovery
is trust-on-first-use (TOFU), so the first connection must be trustworthy.

Pins contain **public keys only**, defaulting to
`<cwd>/data/kernel-webhook-pins`. Put this directory on persistent storage.
`createFileKernelWebhookPinStore(directory)` selects another persistent path.
The file store uses an exclusive per-kernel advisory lock and atomic replacement,
so concurrent first-boot requests cannot silently overwrite each other's pins.
The default file adapter requires Linux util-linux `/usr/bin/flock` and a local
filesystem supporting advisory locks. A bounded `flock` subprocess locks an
inherited descriptor and exits; the parent descriptor retains ownership for the
whole operation. Closing it or crashing the parent releases the lock automatically.
An existing empty/stale `.lock` file therefore does not brick verification.
The persistent lock inode must not be deleted while workers run. Missing tooling
fails closed with `STORE`; use host/image provisioning for this prerequisite or
an injected shared durable pin adapter. No secret value is passed to the helper.
Do not delete pin files automatically or on network errors. An intentional
rotation with no overlap requires an operator to inspect and explicitly reset
that kernel's pin out of band.

A fetched key set can replace a pin only when an active fetched entry matches
**both the kid and public key** of an existing pin. Kids are independently
recomputed from public keys. Only currently published, non-expired keys can
verify deliveries. Expired grace keys are always rejected; a publication withdrawal
is observed within the bounded cache TTL (or immediately with caching disabled).
The kernel must publish old and new keys together during a rotation grace
window, and every consumer must observe that overlap before the old key is
withdrawn. Discovery or persistence failures reject the delivery.

Defaults reject timestamps older than 300 seconds or more than 300 seconds
in the future. `maxAgeSeconds`, `futureToleranceSeconds`, `fetchTimeoutMs`,
`fetch`, and `clock` (milliseconds since epoch) can be injected for tests.
Replay protection is an atomic in-memory store with at most 100,000 live
nonces; it prunes expired entries and fails closed at capacity rather than
evicting live replay evidence. Default nonce and lazy public-pin stores are
shared process-wide across duplicate server bundles and hot reloads via a
global symbol registry. Replay evidence is **single-process and resets on restart**.
Multi-worker/serverless deployments must supply a shared durable `nonceStore`
whose `consume(key, expiresAtMs)` atomically inserts an unseen key with expiry,
returning `false` for a duplicate. Never implement this as separate GET/SET
operations. Public pins are namespaced by normalized kernel auth URL; nonce keys
also include the recipient audience. Application event handling should additionally
be idempotent.

Custom durable `pinStore` adapters implement `load(namespace)` (returns stored
key entries or `null` on first use), `save(namespace, keys)`, and
`withLock(namespace, operation)`. The lock **must serialize the entire callback
across every worker using that store**, including bootstrap, discovery and
load/save. Store errors must throw, never pretend a failed read means no pin.
Public entries contain `kid`, `publicKey` (64 lowercase hex characters),
`algorithm: 'Ed25519'`, `validFrom` (ISO timestamp), and optional `validUntil`.

The exported `canonicalKernelWebhookPayload` helper is shared with senders.
It requires `audience` and produces `imajin-webhook-v1`, recipient app DID,
integer Unix timestamp seconds, UUID nonce,
uppercase HTTP method, URL pathname plus query, and lowercase SHA-256 hex of
the exact raw body, joined with newlines (no trailing newline). The wire
headers are `x-kernel-audience`, `x-kernel-kid`, `x-kernel-timestamp`, `x-kernel-nonce`, and
`x-kernel-signature` (128-character Ed25519 hex). Verification uses Node's
Ed25519 implementation, never string comparison of signatures.
The helper does not accept unsigned deliveries or legacy shared-secret headers;
that does not describe the unmigrated standalone receivers noted above.

Error codes are `INVALID_REQUEST`, `STALE`, `FUTURE`, `SIGNATURE_INVALID`,
`UNKNOWN_KEY`, `TRUST`, `DISCOVERY`, `STORE`, `REPLAY`, `INVALID_BODY`, and
`AUDIENCE_MISMATCH`.

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
