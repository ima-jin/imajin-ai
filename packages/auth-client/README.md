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
only `IMAJIN_KERNEL_URL`, `IMAJIN_APP_DID`, and a one-time
`IMAJIN_APP_CLAIM_CODE` — shown once on the kernel operator's `/jin`
approval card. Exchange it for the real signing key at boot:

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

`loadAppSigningKey()` throws on any failure (missing config, an
already-redeemed or expired claim code, a revoked grant) rather than
degrading silently — a signing key is the app's own identity, so a
misconfigured deploy should fail loudly at boot. The claim code is
single-use: if it's already been redeemed (e.g. after a restart that lost
the in-memory key), ask the kernel operator to re-approve `apps.provision`
with `reissueClaim: true` for a fresh one.

## Part of Imajin

[Imajin](https://imajin.ai) — sovereign technology infrastructure. Open source.
