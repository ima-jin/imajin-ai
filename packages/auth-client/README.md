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

## Part of Imajin

[Imajin](https://imajin.ai) — sovereign technology infrastructure. Open source.
