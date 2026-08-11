# Service Credentials for Machine-to-Machine Kernel Reads

> Addresses #1800. A registered app calling the kernel from an automated
> context — a webhook, a cron job, a background settlement flow — with no
> human session, no borrowed human attestation, and no weakening of scope
> enforcement.

## The problem this replaces

`catalyst-power/xprize#68`'s AgriFortress Stripe settlement webhook needs to
call `GET /supply/api/lot/{correlationId}` to build a `.fair` manifest. A
webhook has no human session and no consent attestation to present. The
stopgap it used, `APP_ATTESTATION_ID`, borrowed one fixed human's consent
attestation for every automated call:

- **Misattribution** — the read is signed as if a specific human requested
  it, when no human is involved.
- **Single point of failure** — if that one human's attestation is revoked
  or expires, every automated call using it breaks, for every caller relying
  on it.

## The credential: an app-service token

The kernel already has a session-less credential shape for exactly this —
the *app-service token*, `typ: 'app-service+jwt'`, minted by
`POST /auth/api/apps/token/service` (#1141). #1800 is the confirmation +
test coverage that this credential satisfies the machine-to-machine read
case end-to-end, not a new auth path.

**Issuance.** The app proves possession of its own registered Ed25519
keypair — a signature over `${appDid}:${nonce}:${timestamp}` — no human
consent flow, no attestation. The kernel checks the app is `active` in
`registry.apps` and mints a ~10-minute EdDSA JWT.

**Attribution.** The token's `sub` and `azp` are both the app's own DID.
There is no `userDid` and no `attestationId` — verifying it
(`POST /auth/api/apps/token/verify`) returns an `AppAuthContext` with
`userDid: ''`, `attestationId: ''`, and `isServiceToken: true`. Nothing in
the credential can be mistaken for, or substituted with, a human identity.
Contrast with a user-delegated app token (`app+jwt`), where `sub` is the
consenting human's DID and `attestationId` points at their consent record.

**Scope.** The token carries whatever is in the app's own
`requestedScopes` (registered at `POST /api/registry/apps`, updatable via
`PATCH /api/registry/apps/:appId`), clamped to the known scope vocabulary
(`validateScopes`). For the AgriFortress case that's `supply:read`.

**Rotation.** The app owner updates `requestedScopes` via
`PATCH /api/registry/apps/:appId` at any time; the next mint carries the
new scopes. There is no separate "credential" to rotate — the credential is
re-derived from the app's registration state on every mint, so registration
changes take effect on the next ~10-minute refresh.

**Revocation.** The app owner calls `DELETE /api/registry/apps/:appId`,
which sets `registry.apps.status = 'revoked'`. `POST /auth/api/apps/token/service`
refuses to mint a new token for a revoked app (`403`). Verification itself
is stateless (no DB round-trip, by design — see the doc comment on
`verifyBearerAppToken` in `packages/auth/src/require-app-auth.ts`), so an
already-minted token remains valid for the remainder of its ~10-minute TTL
after revocation. This is the same bounded-revocation-window tradeoff the
kernel already accepts for every short-lived app token (#1069); #1800 does
not loosen or tighten it for the service-token case.

## Scope enforcement is unchanged

`requireAppAuth(request, { scope })` is the single gate, for both
user-delegated and service tokens. A route that only needs to know "is the
caller allowed to do X", like `GET /supply/api/lot/{correlationId}`
(`handleLotGet` in `apps/kernel/src/lib/supply.ts`), calls it with just a
scope and never looks at `userDid` — so a service token with the right
scope satisfies it exactly the way a user-delegated token would. Nothing
about *what* a scope reaches changed; only *who* the credential can now
identify as, without a human in the loop, changed.

A route that needs to *attribute an action to a person* — for example the
supply-chain write routes, which stamp `issuer`/`subject` with the caller's
identity — still requires `appAuth.userDid` to be non-empty and rejects
service tokens with `403 App token has no delegating user`
(`parseStageRequest` in `apps/kernel/src/lib/supply.ts`). Writes need a
human (or a human's registered agent) to attribute to; reads that describe
system state, like a lot's stage history, do not.

## Calling it as a client

```ts
import { crypto } from '@imajin/auth';

const nonce = crypto.bytesToHex(crypto.hexToBytes(crypto.generatePrivateKey())); // any ≥16-char random string
const timestamp = new Date().toISOString();
const challenge = `${appDid}:${nonce}:${timestamp}`;
const signature = crypto.signSync(challenge, appPrivateKeyHex);

const { token } = await fetch(`${kernelUrl}/auth/api/apps/token/service`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appDid, nonce, timestamp, signature }),
}).then((r) => r.json());

await fetch(`${kernelUrl}/supply/api/lot/${correlationId}`, {
  headers: { Authorization: `Bearer ${token}` },
});
```

Use `crypto.signSync` — the raw Ed25519 primitive — not the wrapper
`signSync` also exported from `@imajin/auth`'s top level, which returns a
`SignedMessage` envelope rather than a bare hex signature and will not
verify against the kernel's `verifySignature` check. `mintAppToken` in
`apps/broker-agent/src/token.ts` is the reference client implementation;
`apps/broker-agent/src/__tests__/token.test.ts` pins that it signs the raw
challenge string.

## Test coverage

- `packages/auth`'s `require-app-auth.ts` — dual-token scope gate (unchanged
  by #1800, exercised in the tests below).
- `apps/kernel/src/lib/auth/__tests__/jwt.test.ts` — attribution and scope
  fidelity of `createAppServiceToken` / `verifyAppToken` at the payload
  level, contrasted against the user-delegated `app+jwt` shape.
- `apps/kernel/app/auth/api/apps/token/service/__tests__/route.test.ts` —
  issuance: correct scope clamp, mint-time revocation, proof-of-possession
  failure modes.
- `apps/kernel/app/auth/api/apps/token/verify/__tests__/route.test.ts` —
  verification: scope gate (granted/out-of-scope), attribution shape for
  service vs. delegated tokens.
- `apps/kernel/src/lib/__tests__/supply-service-credential.test.ts` — the
  full boundary, real mint → real verify → real `requireAppAuth` →
  `handleLotGet`: correct scope succeeds, out-of-scope fails, a revoked app
  can no longer mint, and the resolved `AppAuthContext` identifies the app
  principal and never a human DID.
- `apps/broker-agent/src/__tests__/token.test.ts` — `mintAppToken` signs the
  raw challenge string with the primitive the kernel actually verifies.
