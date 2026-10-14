# Signed kernel callbacks (#2798)

Apps verify kernel callbacks with `verifyKernelWebhook` from `@ima-jin/auth`
(the published name of the workspace's `@imajin/auth`). This is the server-side
SDK apps already use for `loadFromVault`; `auth-client` is the browser session SDK
and is not the home for server-side TOFU files or replay protection.

## Wire contract

Every kernel callback carries four headers:

- `x-kernel-kid`: `computeKeyKid` of the kernel's published Ed25519 public key.
- `x-kernel-timestamp`: canonical integer Unix seconds.
- `x-kernel-nonce`: unique UUID for this delivery attempt, not a credential.
- `x-kernel-signature`: hex detached Ed25519 signature (64 bytes).

The UTF-8 canonical string has six lines, no trailing newline: `imajin-webhook-v1`,
timestamp, nonce, uppercase HTTP method, URL pathname plus query string, and
lowercase SHA-256 hex of the exact raw request body bytes. Do not parse and
re-serialize the body before verification. Route rewriting must preserve the
signed external pathname/query; the kernel signs the URL it actually calls.
Authorization bearer headers, when temporarily present, are not the signature.

Call `await verifyKernelWebhook<MyPayload>(request, { authServiceUrl })` before
any business effect. `authServiceUrl` is the trusted configured kernel URL ending
in `/auth` (never supplied by the callback sender). It defaults to
`AUTH_SERVICE_URL`. The helper returns parsed JSON or throws `KernelWebhookError`;
the generic parameter is not schema validation, so validate the returned shape
before acting. Do not call `request.json()` first.

The default window is ±300 seconds. Set `maxAgeSeconds` and
`futureToleranceSeconds` explicitly only where needed; synchronize host clocks.
Crypto verification uses Ed25519 verification, not string equality of signatures.
Unsigned, stale, future, replayed, tampered or wrong-method/path callbacks fail closed.

## Trust and rotation

Discovery is `/auth/.well-known/kernel-signing-key`. Bootstrap over a trusted TLS
connection to the configured kernel. The default durable pin holds public keys
only, not a secret. Protect the pin location from untrusted writes and persist it
across deploys. An injected `pinStore` must implement `load`, `save` and
`withLock(namespace, callback)`; load/reconcile/save is serialized across workers.

After first use, a newly fetched key set is trusted only when it shares both a
`kid` and its public key with the stored pin. No-overlap replacement fails with
`TRUST`, not an automatic re-pin. Currently published keys are accepted during
their validity bounds; a removed/expired old key cannot authenticate callbacks.
Publish old and new keys together during the rotation grace window so apps learn
the new key without any env or file edit. Do not delete pins to bypass a trust
failure; investigate discovery/rotation first. Rotation is the existing operator
key-rotation tool flow, not secret copying.

## Replay storage

The default in-memory nonce store is atomic within one process and evicts expired
entries; it is not restart-safe or shared across replicas. Production replicas
must inject a durable `nonceStore` with atomic
`consume(namespacedNonce, expiresAtMs): Promise<boolean> | boolean`: true only
for the first insert, false for reuse. The SDK passes a kernel-namespaced nonce
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
`TRUST`, `DISCOVERY`, `STORE`, `REPLAY`, `INVALID_BODY`.

Apps should map authentication failures to 401, malformed JSON to 400, and
discovery/store availability failures to 503 for retry. Log codes and transaction
identifiers only, never headers or credentials. Do not catch a verification error
and continue processing.

## Operator rollout (tool steps only)

1. Release the SDK through the reviewed Release workflow and its automated package
   publishing job; do not publish from a shell or hand-bump a feature version.
2. Deploy the kernel through its deploy workflow. Callback URLs are non-secret
   config; no new shared webhook credential is provisioned.
3. Per-app #2241 children deploy verification with durable pins/replay storage and
   exercise a signed payment callback, replay, stale, tampered and unsigned inputs.
4. Apps call notify using their own claimed app identity and scoped service token.
   Kernel-internal calls use the vault-resolved internal key; no env bearer is needed.
5. After the per-app verification children close, remove the temporary legacy
   bearer bridge through the reviewed removal change described below.

## Dated removal note — 2026-10-14

Only the isolated `apps/kernel/src/lib/auth/kernel-webhook-legacy.ts` bridge may
read `COFFEE_WEBHOOK_SECRET`, `LEARN_WEBHOOK_SECRET`, `MARKET_WEBHOOK_SECRET` or
`EVENTS_WEBHOOK_SECRET`. It may attach a legacy bearer only while that app's
variable remains set on the host, and warns once per variable per process.
Delivery always requires and carries the detached signature even on that path.
There is no `NOTIFY_WEBHOOK_SECRET` compatibility branch.

Removal trigger: **all per-app verify children of #2241 are closed**. Delete the
legacy module, its import and optional header spread in the shared callback
signer, and the legacy-specific tests. Exact line references are recorded in the
PR callback inventory after integration; symbol references remain stable:
`legacyKernelWebhookHeaders` and its sole callsite. Remove this note with that
change. Until then do not provision, copy or rotate a legacy webhook bearer.
