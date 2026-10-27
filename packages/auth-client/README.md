# @ima-jin/auth-client

"Sign in with Imajin" SDK for federated apps. Lightweight JWT session management + ready-made Next.js route handlers.
App sign-in sessions are bound to a kernel-verified single-use authorization code.
Standalone apps must forward root sign-in callback parameters before applying login or claim gates.

## Install

```bash
npm install @ima-jin/auth-client
```

## Quick Start

### 1. Configure

```ts
// src/lib/auth-config.ts
import type { ImajinAuthConfig } from '@ima-jin/auth-client';

export const authConfig: ImajinAuthConfig = {
  secret: process.env.SESSION_SECRET!,
  authUrl: process.env.IMAJIN_AUTH_URL!,
  appDid: process.env.IMAJIN_APP_DID!,
  appId: process.env.IMAJIN_APP_ID!,
  publicUrl: process.env.NEXT_PUBLIC_APP_URL,
  loginRedirect: '/dashboard',
};
```

### App session cookie isolation

Configure the same stable `appDid` for every session reader and handler. The
default cookie name is `imajin_app_session_` followed by the SHA-256 hex digest
of the full app DID (UTF-8). Different app DIDs get distinct cookie names,
including when apps share the kernel host and use `path=/`. The cookie stays
host-only, HttpOnly and SameSite=Lax.

An explicit `cookieName` still overrides derivation and can be used without
`appDid`; choose a valid, unique cookie name for each app on a shared host.
Cookie names are resolved lazily on each request, never at handler creation.
Route modules can construct handlers during `next build` without runtime app
identity or secrets. At request time, `imajin_session` (reserved for the kernel),
an invalid cookie name, or missing app identity without an override rejects
before any cookie is read or written, rather than falling back to a shared cookie.

Upgrading from the old default signs users out of each app once. The SDK
does **not** read, migrate or clear the old `imajin_session` cookie, since it
may now contain the kernel session. Signing back into an app writes only
that app's cookie; app logout clears only that same cookie.

### 2. Create route handlers

```ts
// app/api/auth/login/route.ts
import { createLoginHandler } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';
export const GET = createLoginHandler(authConfig);

// app/api/auth/callback/route.ts
import { createCallbackHandler } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';
export const GET = createCallbackHandler(authConfig);

// app/api/auth/session/route.ts
import { createSessionHandler } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';
export const GET = createSessionHandler(authConfig);

// app/api/auth/logout/route.ts
import { createLogoutHandler } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';
export const POST = createLogoutHandler(authConfig);
```

Point the app/template sign-in button at its own `/api/auth/login` route
(including the app basePath), not directly at kernel consent. `appId` is the
registry app ID; `appDid` remains its DID. The login handler creates an
app-isolated, host-only HttpOnly SameSite=Lax state cookie with a five-minute
lifetime, then redirects to the kernel's `/auth/authorize` page with that state.
Route factories remain lazy and do not read runtime configuration during build.

After consent, the kernel redirects to the registered callback with `code`
and `state`. The code has a 60-second lifetime and is single-use. The callback
checks and clears its state cookie, loads the app signing identity through
`loadAppSigningKey()`, and exchanges the code at `/auth/api/apps/token` using
Ed25519 proof of possession. The session DID and attestation come only from the
kernel response. Profile fields are display data, not identity authority.
Failures redirect within the app with `auth_error=authorization_invalid` and
do not write a session cookie. Callback responses are no-store and
use `Referrer-Policy: no-referrer`.

For standalone `imajin-app-template` forks, mount both login and callback
handlers, configure the registry ID/DID plus the full public app URL, keep the
existing signing-key bootstrap, and forward root callbacks before login gates
as below. These changes target the auth-client 0.8.28 release; the normal
Release workflow owns manifest version bumps and publication. Standalone
repository dependency updates and rollout are separate changes.

### 3. Check session in server components

```ts
import { getSession } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';

const user = await getSession(authConfig);
if (!user) redirect('/');
```

### Standalone apps: forward the root callback in middleware

The kernel sends sign-in callbacks to the registered app home URL, for example
`https://jin.imajin.ai/coffee?code=...&state=...`.
`forwardAuthCallback` issues a **307** to `/coffee/api/auth/callback` with the
identical query string. Only the app root (with or without a trailing slash)
and two nonempty callback parameters qualify; other requests return `null`.
The callback route above creates the session and redirects within the app.

In an existing `middleware.ts`, rename the existing exported `middleware`
function to a non-exported `appMiddleware` function, leaving its body unchanged.
Then add this import and wrapper **before any claim/login gate**:

```ts
import { type NextRequest } from 'next/server';
import { forwardAuthCallback } from '@ima-jin/auth-client/middleware';

export function middleware(request: NextRequest) {
  const callback = forwardAuthCallback(request, {
    publicUrl: process.env.NEXT_PUBLIC_APP_URL,
    basePath: process.env.NEXT_PUBLIC_BASE_PATH,
  });
  if (callback) {
    return callback;
  }
  return appMiddleware(request);
}
```

`appMiddleware` is your existing implementation, including the claim gate and
its conditional `standaloneDashboardMiddleware(request, { service: 'coffee' })`
call from `@ima-jin/config`; keep those checks and their ordering unchanged.
Do not replace the claim gate with an unconditional dashboard middleware call.
Keep the existing middleware `config` export (including `runtime: 'nodejs'`
when the claim gate reads the keystore). Its literal matcher must include `'/'`
as well as its existing catch-all so Next.js matches the bare basePath root:

```ts
export const config = {
  runtime: 'nodejs',
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

Use the `/middleware` entry to avoid pulling session, vault, or Node-only
keystore code into the helper's import graph. It also works in Edge middleware
when the rest of your middleware does not require Node.js. The root entry
exports the helper too, for existing Node.js consumers.

Set `NEXT_PUBLIC_APP_URL` to the **full public app URL including its basePath**
(for example `https://dev-jin.imajin.ai/coffee`) and use the same value for
`authConfig.publicUrl`. The helper's optional `basePath` overrides path
inference; otherwise the public URL pathname is used, falling back to
`request.nextUrl.basePath`. This supports both raw and Next.js-normalized
request paths.

Both middleware and handler redirects prefer `publicUrl` for the public origin.
Without it, they use the first `x-forwarded-host` / `x-forwarded-proto` values
(falling back to the request protocol), then the request origin. Only rely on
forwarding headers behind ingress that overwrites them; configure `publicUrl`
for production.

`loginRedirect` and `logoutRedirect` are app-relative: `/` becomes `/coffee/`,
`/dashboard` becomes `/coffee/dashboard`, and all callback `auth_error`
redirects stay under `/coffee`. Already-prefixed paths are not doubled.
Absolute URLs retain their destinations. Apps without a basePath keep their
existing root destinations. Keep the registered callback URL unchanged.

Regression command (from the monorepo root):
`pnpm exec vitest run packages/auth-client/tests`.
Repository policy reserves all manifest version bumps for the normal reviewed
Release workflow. Feature changes do not select or bump package versions.

### 4. Fetch this app's own signing key at boot (#2411, #3146)

An app provisioned via the kernel's `apps.provision` (see
`ima-jin/imajin-ai`'s `docs/REGISTRATION.md`) never holds a raw
`IMAJIN_APP_PRIVATE_KEY` in any env file. Instead, `.env.local` carries
`IMAJIN_KERNEL_URL`, `IMAJIN_APP_DID`, and — only until first boot — a
one-time `IMAJIN_APP_CLAIM_CODE`, shown once on the kernel operator's
`/jin` approval card:

```ts
// src/lib/signing-identity.ts
import { loadAppSigningKey } from '@ima-jin/auth-client';

let signingKey: Awaited<ReturnType<typeof loadAppSigningKey>> | null = null;

export async function bootstrapSigningIdentity(): Promise<void> {
  signingKey = await loadAppSigningKey();
}

export function getSigningIdentity() {
  if (!signingKey) throw new Error('signing identity not bootstrapped yet');
  return signingKey; // { appDid, privateKey, publicKey }
}
```

**First boot vs. every later boot** (Ryan's restart-authentication ruling,
#2411): `loadAppSigningKey()` mints its own Ed25519 "bootstrap" keypair on
first boot, exchanges the claim code + that keypair's public half for the
real signing key, and persists ONLY the bootstrap keypair — never the
signing key — in a local keystore file (`IMAJIN_APP_KEYSTORE`, default
`./.imajin/keystore.json`, mode `0600`). Every later boot signs a fresh
challenge with that persisted bootstrap key instead of spending another
claim code, so no operator action is needed on an ordinary restart.

Await `loadAppSigningKey()` in the server's startup/instrumentation hook
before serving requests. With an existing keystore, bootstrap fetches retry
HTTP 5xx and network failures (including connection refused/reset and fetch
TypeError) using exponential backoff with equal jitter. Every attempt signs
a new nonce and timestamp; failures are not cached by the loader.
Defaults: a **120,000ms total budget** including requests, **10,000ms per
request**, and delay windows starting at **1,000ms**, doubling up to
**15,000ms** (each actual wait is 50–100% of its window).

Override these with `retry: { maxElapsedMs, requestTimeoutMs, initialDelayMs,
maxDelayMs }`. Each supplied duration must be a positive integer no larger
than 2,147,483,647ms. Requests and waits are clipped to the remaining budget;
stalled fetches/body reads are aborted. On exhaustion the loader logs one
sanitized diagnostic naming the app and last status/failure, then calls
**`process.exit(1)`** so pm2 restarts the process rather than leaving it
online with a rejected instrumentation promise. Tests can inject
`exit: (code) => { ... }`; if that hook returns, the loader still throws.
Do not override the fatal hook in production.

HTTP 4xx (including 401/403/404/410) fail immediately with the app DID and
status, without retries. Missing configuration, malformed success responses,
and caller cancellation also throw rather than degrading silently.
Provider response/error text and key material are never included in diagnostics.
First-boot claim exchanges remain single-shot: automatically replaying a
one-time claim could consume it without safely persisting its bootstrap key.
These retries apply only to the existing-keystore bootstrap fetch, not token
minting, vault loading, or claim semantics.

A signing key is the app's own identity, so a misconfigured deploy should
fail loudly at boot. If the
local keystore is ever lost (disk wipe, redeploy to a fresh host), ask the
kernel operator to re-approve `apps.provision` with `reissueClaim: true`
for a fresh claim code — redeeming it also revokes the lost keystore's
bootstrap key so it can never authenticate a fetch again.

| Env var | When needed |
|---|---|
| `IMAJIN_KERNEL_URL` | Always |
| `IMAJIN_APP_DID` | Every later boot (once a keystore exists) |
| `IMAJIN_APP_CLAIM_CODE` | First boot only (or after a `reissueClaim: true` rebind) |
| `IMAJIN_APP_KEYSTORE` | Optional — defaults to `./.imajin/keystore.json` |

### 5. Mint an app token from client components (`/browser`)

The `.` entry also imports `fs`, `crypto` and `path` (via `loadAppSigningKey()`
and the keystore), so importing anything from it into a client component
fails the Next.js build (`Module not found: Can't resolve 'fs'`). For code
that runs in the browser, import from the browser-safe subpath instead:

```ts
'use client';
import { requestAppToken } from '@ima-jin/auth-client/browser';
import type { RequestAppTokenOptions, RequestAppTokenResult } from '@ima-jin/auth-client/browser';

const minted = await requestAppToken({
  authUrl: process.env.NEXT_PUBLIC_IMAJIN_KERNEL_URL!,
  aud: window.location.host,
  scopes: ['profile:read'],
});
// minted: { token, expiresIn, scopes } | null
```

`requestAppToken` calls `POST {authUrl}/auth/api/tokens/app` with
`credentials: 'include'` (so the user's kernel session cookie is sent) and
returns `null` on any failure.

**When to use which entry**

| Entry | Use it for |
|---|---|
| `@ima-jin/auth-client/browser` | Client components / any browser bundle — only `requestAppToken` and its types |
| `@ima-jin/auth-client` | Server code — sessions, route handlers, `loadAppSigningKey()` (it also still exports `requestAppToken`, so existing imports keep working) |
| `@ima-jin/auth-client/handlers` | Next.js route handler factories |
| `@ima-jin/auth-client/middleware` | Root callback forwarding without Node-only dependencies |

The browser entry's import graph is guaranteed free of node built-ins,
`next/headers`, and keystore/signing-key code; `tests/browser-entry.test.ts`
bundles it for a browser target to enforce that.

## App-declared secrets (#2799)

After `loadAppSigningKey()` establishes the bootstrap keystore, server code
can call `loadFromVault({ keys: [{ key: 'SESSION_SECRET', onMissing: 'fail' }] })`.
It returns `{ values, degraded }`. `appDid`, `kernelUrl`, and `keystorePath`
use the same environment defaults as `loadAppSigningKey()`. Names must match
the app manifest's `secrets` declarations; no grant IDs or generation recipes
are supplied by the caller.

This auth-client helper is **not** the generic grant loader exported by
`@imajin/auth`; that API and its deferred acknowledgement handles are unchanged.
Here, the bound bootstrap keystore (not the registered app signing key)
authenticates every fetch. Domain, app DID, requested names, recipient key,
nonce and timestamp are signed. The kernel returns only a vault-core sealed
envelope; the SDK checks the decrypted DID, nonce and requested names before
returning values. Rotation is picked up on the next fetch.

Values stay in process memory: never persist, log, or copy them into environment
variables. `onMissing: 'fail'` throws a value-free error; `'degrade'` omits
the unavailable name from `values` and lists it in `degraded`. Each key uses
an independent fresh request so optional keys cannot hide required ones.
The SDK requires HTTPS except for literal loopback hosts; redirects are refused.
Production ingress must enforce public TLS. The handler permits internal HTTP
URLs under a TLS-terminating reverse proxy without trusting forwarding headers.
The endpoint refuses inactive apps, revoked/undeclared names, wrong keys,
altered requests and nonce replay. Nonces are currently tracked in the kernel
process, matching the existing single-instance bootstrap fetch mechanism.
This helper does not issue acknowledgements or claim that a fetched value was used.

### Load before importing the server (#2821)

`operator-supplied` manifest declarations use the same encrypted fetch path after
an operator supplies the value and countersigns a set/rotate proposal on `/jin`.
Manifest sync alone does not produce an operator value. Pending staging is not
an app grant, and responses/approval cards never echo entered values.

Use `createVaultBoot<Config>({ vault, configure })` for module-load consumers.
Keep the returned `boot` instance in a server-only config module with no DB/server
imports. After `loadAppSigningKey()` establishes the bootstrap keystore, call
`boot.start(async (config) => { const server = await import('./server'); return server.start(config); })`.
The helper awaits vault loading and optional async configuration before invoking
that callback. Imported DB modules can then read `boot.getConfig().DATABASE_URL`
at module initialization. Refactor existing `process.env` consumers to use this
config; the helper never populates `process.env`.

`getConfig()` fails before initialization or after failed startup. Configuration
is shallow-frozen and typed `Readonly<Config>`. `start()` is one-shot (also for
concurrent attempts); retry by restarting the process. Load/configure/start errors
are replaced with a fixed diagnostic without their original messages or causes.
Never statically import the DB/server before this boundary, print configuration,
or log caught provider errors. See
[`docs/app-self-secrets-author.md`](../../docs/app-self-secrets-author.md) for the
complete entrypoint/config/DB example and follow-up adoption inventory.

## Part of Imajin

[Imajin](https://imajin.ai) — sovereign technology infrastructure. Open source.
