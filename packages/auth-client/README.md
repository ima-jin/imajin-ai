# @ima-jin/auth-client

"Sign in with Imajin" SDK for federated apps. Lightweight JWT session management + ready-made Next.js route handlers.

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
  appDid: process.env.IMAJIN_APP_DID,
  publicUrl: process.env.NEXT_PUBLIC_APP_URL,
  loginRedirect: '/dashboard',
};
```

### 2. Create route handlers

```ts
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

### 3. Check session in server components

```ts
import { getSession } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';

const user = await getSession(authConfig);
if (!user) redirect('/');
```

### 4. Fetch this app's own signing key at boot (#2411)

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

`loadAppSigningKey()` throws on any failure (missing config, an
already-redeemed or expired claim code, an invalid bootstrap signature, a
revoked grant) rather than degrading silently — a signing key is the app's
own identity, so a misconfigured deploy should fail loudly at boot. If the
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

## Part of Imajin

[Imajin](https://imajin.ai) — sovereign technology infrastructure. Open source.
