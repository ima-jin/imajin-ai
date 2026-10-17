# Signed kernel callbacks (#2798)

Apps adopting signed verification use `verifyKernelWebhook` from `@ima-jin/auth/kernel-webhook`
(the published name of the workspace's `@imajin/auth`). This is the server-side
SDK apps already use for `loadFromVault` and shared cryptographic contracts.
`auth-client` owns federated login/session and app-keystore bootstrapping; webhook
verification belongs alongside the shared auth cryptography rather than session handlers.

## Wire contract

Every kernel callback carries five headers:

- `x-kernel-audience`: the recipient app's registered DID, never a caller-selected payload field.
- `x-kernel-kid`: `computeKeyKid` of the kernel's published Ed25519 public key.
- `x-kernel-timestamp`: canonical integer Unix seconds.
- `x-kernel-nonce`: unique UUID for this delivery attempt, not a credential.
- `x-kernel-signature`: hex detached Ed25519 signature (64 bytes).

The UTF-8 canonical string has seven lines, no trailing newline: `imajin-webhook-v1`,
audience, timestamp, nonce, uppercase HTTP method, URL pathname plus query string, and
lowercase SHA-256 hex of the exact raw request body bytes. Do not parse and
re-serialize the body before verification. Route rewriting must preserve the
signed external pathname/query; the kernel signs the URL it actually calls.
Authorization bearer headers, when temporarily present, are not the signature.

Call `await verifyKernelWebhook<MyPayload>(request, { audience: ownAppDid, authServiceUrl })`
before any business effect. `audience` is required and comes from the receiver's
own registered identity/keystore, never from a request header or body. A callback
addressed to another app is rejected before discovery or nonce consumption, even
if that app shares the same callback path. Changing the audience header invalidates
the signature. `authServiceUrl` is the trusted configured kernel URL ending
in `/auth` (never supplied by the callback sender). It defaults to
`AUTH_SERVICE_URL`. The helper returns parsed JSON or throws `KernelWebhookError`;
the generic parameter is not schema validation, so validate the returned shape
before acting. Do not call `request.json()` first.

The default window is ±300 seconds. Set `maxAgeSeconds` and
`futureToleranceSeconds` explicitly only where needed; synchronize host clocks.
Crypto verification uses Ed25519 verification, not string equality of signatures.
Unsigned, stale, future, replayed, tampered or wrong-audience/method/path callbacks fail closed.

The kernel resolves active registry entries for its named payment receivers.
Generic bus webhook configurations identify a recipient with
`recipient: { appDid }` or `recipient: { appSlug }`; destinations must match that
app's registered origin or a trusted, fixed kernel-routed service URL. The
coffee/events/learn/market mappings apply to provisioned apps regardless of
registry tier; relative nav paths and bare audience slugs do not grant origins. Existing
`settlement.completed` configurations without a recipient resolve the registered
events app, preserving the registered-app delivery path for standalone
[ima-jin/events](https://github.com/ima-jin/events). Other missing/revoked or
ambiguous recipients fail closed; the event payload cannot select the audience.

## Trust and rotation

Discovery is `/auth/.well-known/kernel-signing-key`. Bootstrap over a trusted TLS
connection to the configured kernel. The default durable pin holds public keys
only, not a secret, under `data/kernel-webhook-pins` relative to the app's working
directory. HTTPS discovery is required except loopback HTTP; `allowInsecureHttp`
is an explicit opt-in for a trusted private development network, never public use.
Protect the pin location from untrusted writes and persist it
across deploys. An injected `pinStore` must implement `load`, `save` and
`withLock(namespace, callback)`; load/reconcile/save is serialized across workers.

The default file adapter requires Linux util-linux `/usr/bin/flock` and a local
filesystem supporting advisory locks. The executable is fixed, never looked up
through PATH or caller configuration. Acquisition is bounded.
The parent opens a persistent inode; a short-lived `flock` subprocess locks its
inherited descriptor and exits. The parent descriptor retains the kernel-held
lock until close or process death, so no long-lived helper can silently lose the
lease. Existing empty/stale lock
files do not own locks and need no manual deletion. Lock files remain in place
to prevent competing workers locking different inodes; do not delete them during
operation. Missing lock tooling fails closed with `STORE`; provision the runtime
prerequisite through the host/image tool flow, or supply an appropriate shared
`pinStore` adapter. Pin contents are never discarded during crash recovery.

After first use, a newly fetched key set is trusted only when it shares both a
`kid` and its public key with the stored pin. No-overlap replacement fails with
`TRUST`, not an automatic re-pin. Trusted discovery sets are cached for a bounded
60-second TTL by kernel and pin-store identity; concurrent refreshes share one
fetch. Unknown key IDs trigger a rate-limited refresh, including failed fetches.
`discoveryCacheTtlMs: 0` disables caching when immediate publication checks are
needed. Every request still checks key validity and timestamp bounds; expired
grace keys cannot authenticate even from a cached set. Publication withdrawal can
take at most the cache TTL to be observed. Once the TTL expires, discovery errors
reject the delivery rather than falling back to stale keys.
Publish old and new keys together during the rotation grace window so apps learn
the new key without any env or file edit. Do not delete pins to bypass a trust
failure; investigate discovery/rotation first. Rotation is the existing operator
key-rotation tool flow, not secret copying.

## Replay storage

The default in-memory nonce store is atomic within one process and evicts expired
entries; it is not restart-safe or shared across replicas. Production replicas
must inject a durable `nonceStore` with atomic
`consume(namespacedNonce, expiresAtMs): Promise<boolean> | boolean`: true only
for the first insert, false for reuse. The SDK passes a kernel-and-audience-namespaced nonce
and an expiry that covers the full admissible timestamp window.

A DB adapter can use a table owned by the receiving app, unique primary key
`nonce`, and expiry column. In one atomic operation, insert with
`ON CONFLICT DO NOTHING RETURNING nonce`; true iff one row was returned.
Periodically prune rows whose expiry is past the current time. Never implement
read-then-insert, ignore storage failures, or share a transaction rollback with
business processing. If the app adds that table, its per-app issue must ship its
guarded idempotent migration. This kernel PR adds no schema or nonce table.

Business idempotency is separate: a legitimate re-delivery is signed with a fresh
nonce, while session/transaction identifiers prevent duplicate settlement.

## Typed failures

`KernelWebhookError.code` is one of:
`INVALID_REQUEST`, `STALE`, `FUTURE`, `SIGNATURE_INVALID`, `UNKNOWN_KEY`,
`TRUST`, `DISCOVERY`, `STORE`, `REPLAY`, `INVALID_BODY`, `AUDIENCE_MISMATCH`.

Apps should map authentication failures to 401, malformed JSON to 400, and
discovery/store availability failures to 503 for retry. Log codes and transaction
identifiers only, never headers or credentials. Do not catch a verification error
and continue processing.

## Operator rollout (tool steps only)

**Standalone rollout status (2026-10-14):** coffee#13, learn#15 and market#15
are still open; standalone coffee, learn and market remain **Bearer-only**.
Kernel signatures are additive until those migrations merge and deploy.
The kernel's signed delivery path does not require these shared secrets;
they are temporary legacy Bearers required only by the unmigrated receivers.
Keep the existing kernel `COFFEE_WEBHOOK_SECRET`, `LEARN_WEBHOOK_SECRET` and
`MARKET_WEBHOOK_SECRET` set, matching each app's existing `WEBHOOK_SECRET`;
keep their service URLs configured too. `kernel-webhook-legacy.ts` attaches
the required Bearer only while the corresponding var is set. Removing a var
before that app's migration ships causes payment callbacks to return 401.
Do not generate, copy or rotate credentials for this rollout; retain the
existing configuration until its removal gate is met.

1. Release the SDK through the reviewed Release workflow and its automated package
   publishing job; do not publish from a shell or hand-bump a feature version.
2. Deploy the kernel through its deploy workflow. Callback URLs are non-secret
   config; no new shared webhook credential is provisioned.
   Events now runs from [ima-jin/events](https://github.com/ima-jin/events)
   in dev and prod (cutover status recorded on #2517); signed receiver/contact
   integration is app-owned there. The events#38 prerequisite and patched #2798
   monorepo receiver describe the completed cutover, not a remaining kernel
   workspace app. Preserve the public callback/contact contracts. The #2517
   production release guard still requires #2516 step 8 buy/refund acceptance
   and Ryan's tap 2; source cleanup is not deployment approval.
3. Per-app #2241 children deploy verification with durable pins/replay storage and
   exercise a signed payment callback, replay, stale, tampered and unsigned inputs.
4. Apps call notify using their own claimed app identity and scoped service token.
   Kernel-internal calls use the vault-resolved internal key; no env bearer is needed.
5. Only after the matching child **merges and deploys**, and signed callbacks
   are verified on that app, may its legacy var be removed: coffee#13 for
   `COFFEE_WEBHOOK_SECRET`, learn#15 for `LEARN_WEBHOOK_SECRET`, market#15 for
   `MARKET_WEBHOOK_SECRET`. Do not treat kernel deployment or issue closure
   alone as proof that a standalone receiver has migrated. Remove the bridge
   itself only after the full removal gate below is met.

## Dated removal note — 2026-10-14

Only the isolated `apps/kernel/src/lib/auth/kernel-webhook-legacy.ts` bridge may
read `COFFEE_WEBHOOK_SECRET`, `LEARN_WEBHOOK_SECRET`, `MARKET_WEBHOOK_SECRET` or
`EVENTS_WEBHOOK_SECRET`. It may attach a legacy bearer only while that app's
variable remains set on the host, and warns once per variable per process.
Delivery always requires and carries the detached signature even on that path.
`apps/kernel/src/lib/notify/legacy-auth.ts` also accepts `NOTIFY_WEBHOOK_SECRET`
only while set, on send/broadcast/interest only, with no Authorization header.
It uses timing-safe comparison and a process-wide once warning. A supplied
invalid Bearer never falls back to the legacy lane. Contact, registry and internal
approval callbacks remain vault-only; external internal-approval adapters must
migrate to that existing vault credential before deployment.

Removal trigger: **all per-app verify children of #2241 are closed and their
migrations have merged and deployed**, explicitly including
[coffee#13](https://github.com/ima-jin/coffee/issues/13),
[learn#15](https://github.com/ima-jin/learn/issues/15),
[market#15](https://github.com/ima-jin/market/issues/15) and
[events#38](https://github.com/ima-jin/events/issues/38). Verify signed callback
acceptance on each deployed standalone app before removing its legacy configuration.
Until then retain the existing per-app Bearers; a kernel signature alone does
not satisfy an unmigrated receiver. Delete the
legacy module `auth/kernel-webhook-legacy.ts:12-33`, the import at
`auth/kernel-webhook.ts:5` and optional `legacyWebhookHeaders(app)` spread at
`auth/kernel-webhook.ts:47`, and the legacy-specific cases in
`auth/__tests__/kernel-webhook.test.ts:143-161`.
Also delete `notify/legacy-auth.ts:1-27`, its import at `notify/service-auth.ts:6`
and its conditional call at `notify/service-auth.ts:21`; remove
`notify/__tests__/legacy-auth.test.ts` and the legacy-only cases in
`app/notify/api/__tests__/registered-app-auth.test.ts:126-142`. Auth/notify paths
above are under `apps/kernel/src/lib/`. These exact ranges name the integrated
bridge; stable symbols are `legacyWebhookHeaders` and `acceptsLegacyNotifyCredential`.
Remove this note with that change. Until then do not provision, copy or rotate
a legacy webhook bearer. The bus settlement reactor never accepts a legacy
`config.secret`, including an old DB-backed reactor configuration.
