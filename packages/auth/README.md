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
import { requireSessionOrAppToken } from '@ima-jin/auth';
```

Subpath exports are available for consumers that only need specific
vocabularies without pulling in the rest of the package:

```ts
import { BROKER_CONSENT_SCOPES } from '@ima-jin/auth/broker-consent-vocabulary';
import { SCOPES } from '@ima-jin/auth/scope-vocabulary';
import { GRANT_SCOPES } from '@ima-jin/auth/grant-scopes';
```

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
