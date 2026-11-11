# Operator approvals: notification contract

A source stages a proposal, a named human approves or refuses its exact content,
and the source applies that decision through its own execution mechanism. The
kernel persists the proposal and decision; a notification is not permission to
bypass the source's approval store. The OpenClaw plugin is a separate repository,
connected only through authenticated HTTP/WebSocket contracts.

Read the live [notify spec](https://jin.imajin.ai/notify/api/spec) for ingestion
and internal callbacks, and [Jin spec](https://jin.imajin.ai/jin/api/spec) for
Inbox cards, decisions, expiry and archive controls. These are the route catalogue.

## Transport authority

External notification senders use registered app-service tokens. The selected
endpoint's `notify:send`, `notify:broadcast` or `notify:interest` scope must be
present both in the token and the active app's current approved service scopes.
The countersigned `apps:service-scopes` flow grants that ceiling; registration,
requested scopes, user sessions and user-delegated tokens do not grant it.

Internal callers use the vault-resolved internal Bearer credential supplied at
boot. Internal applied/outcome callbacks require this authority, not notify-send
scope or a user token. SDK `configureNotify` accepts `appTokenProvider` or an
explicit internal provider; unavailable app credentials never fall back to the
more privileged internal lane. Delivery is best-effort/logged, not thrown as an
application failure. See the [notify package](../packages/notify/README.md).

A compatibility lane remains in `src/lib/notify/legacy-auth.ts`: the configured
`NOTIFY_WEBHOOK_SECRET` can authorize send/broadcast/interest via
`x-webhook-secret` only when Authorization is absent. Comparison is timing-safe;
a warning records use. Invalid Bearer auth never downgrades into it. This is not
a new integration path and does not authorize registry/contact/internal approvals.
Disable it only after verifying each existing consumer's token adoption, under
[the webhook security runbook](security/kernel-webhooks.md).

## Request content

Notify ingestion uses scope `operator.approval.requested`, addressed initially to
the configured node operator. For connector proposals carrying a valid
`detail.ownerDid`, the kernel resolves the actual addressee to that owner.

A namespaced proposal supplies `proposalId`, `source`, `kind`, `summary`,
`keysTouched`, optional bounded `detail`, and `contentHash`. Source and subkind
are lowercase hyphenated identifiers with `kind` in `<source>:<subkind>` form.
`detail` is bounded to 16 KiB; source-specific renderers can show its reviewed
fields, otherwise the default card shows summary and touched keys.

The compatibility bare kinds `restart`, `config-mutation` and `other` normalize
to `system-agent:*`. That shape can omit source/detail/hash; any supplied hash
is still verified. A detail-bearing or namespaced proposal requires its hash.

`computeApprovalContentHash` hashes canonical JSON of exactly
`{proposalId, source, kind, summary, keysTouched, detail}`. Ingestion independently
recomputes it and rejects mismatches before persistence. Applying must compare
that same reviewed content, not a refreshed or substituted detail object.

`keysTouched` contains short key paths only, never values or SecretRef objects.
Summary/key paths are rejected for recognizable credential shapes, long encoded
blobs or bearer material; key paths have a constrained character set and length.
This is defense in depth, not permission for an adapter to resolve a secret before
building a proposal. Do not include credentials in detail or diagnostic output.

Optional `signerDid` identifies the requesting agent for decision delivery; it
is not part of the six-field content digest. Missing, non-string or overlong
values are ignored. It does not grant authority or replace signature verification.

## Human addressee and acting identity

`operator.approvals.operator_did` stores the Inbox addressee, not necessarily the
node operator. Connector append/mutate/write proposals with owner metadata go to
that owner; node-level system, vault, access, provisioning and decision-card
proposals go to the node operator.

Inbox reads return only the real session principal's addressed rows. The node
operator cannot read or decide another owner's connector proposal. The decision
must come from the real authenticated addressee; an agent acting for them is
not that human. A supplied owner DID is not authentication.

**This confirm rail is self-only.** `actingFor` and `actingAs` are refused before
proposal ownership lookup on decisions and vault-proposal creation, with
`403 act_as_not_permitted`. This is an intentional exception to ordinary
org-context writes: do not replace the human countersigner with
`resolveActingDid`. Inbox reads can expose act-as metadata so the UI explains
why controls are disabled; switch back to the human identity before deciding.
Other rails that permit org ownership still use the verified acting DID and
record the actual human signer separately. Never fall back silently between them.

## Decision and countersignature

A decision records `approve`, `reject` or `withdrawn`, addressee DID, timestamp,
optional reason/mode, effective content hash and any operator countersignature.
The kernel signs its own witness record; that is not the human's signature.
A source verifies the independent human signature against the addressee's key
before applying when its policy requires it.

The human signs exactly:

```text
canonicalize({contentHash, decision, decidedAt})
canonicalize({contentHash, decision, decidedAt, mode})
```

The second shape applies only when a mode is present. Verification requires the
current registered human key, a valid Ed25519 signature and a timestamp within
five minutes back/thirty seconds forward. An added, removed or altered mode
cannot fall back to the mode-less shape. Invalid supplied signatures return 400
before state mutation, regardless of the requirement flag.

`OPERATOR_COUNTERSIGN_REQUIRED=true` requires the human signature for every
decision including withdrawal. Unset is off: unsigned human-session decisions
can still be node-witnessed. Therefore an unconfigured node does not provide an
unforgeable human approval against a compromised kernel. Do not describe the
feature flag's existence as proof that a deployment requires countersigning.

Decision modes are validated against kind before signing/persistence:

- A decision card approval requires one of that card's option letters; rejection
  or withdrawal has no mode.
- Gateway exec approval permits absent or `allow-once`; rejection permits absent
  or `deny`. `allow-always` is refused.
- GitHub approval permits absent, `single`, `5m` or `24h`; rejection/withdrawal
  has no mode. Other kinds do not accept a mode.

Record verification distinguishes a letter actually covered by the human's
signature from a node-witnessed letter on a mode-less signature. It does not
label the latter as human-countersigned. Verify the exact signed payload.

## Delivery, application and expiry

The kernel publishes `operator.approval.decided` with a `sha256:` effective
content hash, refusing to mutate/publish if it cannot compute that hash. The
same signed payload is addressed once per distinct recipient: the deciding
human and the requesting `signerDid`, when present. Grant-bound subscription
delivery requires live capability and subject audience; durable catch-up uses
the same scoped event log. No requesting signer means human-only delivery.

A source maps approve/reject into its underlying mechanism, checks its local
content hash and treats already-applied/expired decisions as no-ops. A successful
apply reports through the vault-authenticated internal applied callback. It is
idempotent; approval is not execution completion. Gateway exec outcome reporting
adds bounded `exitCode`, `durationMs` and `outputHash` after execution and must not
leak raw output or credentials.

Withdrawal applies only to an approved but not yet applied proposal; an applied
proposal refuses withdrawal with 409. Gateway exec also refuses decisions after
its own deadline. The approval expiry policy retains signed expiry provenance;
archive controls hide resolved cards per principal without deleting rows/history.

Native loop-bound commands use the separate full-command principal wish and
correlated signed outcome rail. Selecting that execution rail suppresses legacy
executable decision fan-out atomically; missing command authority cannot silently
switch back. See [loop contracts](loops-rail-contract.md).

Notifications survive reconnect through the ordinary ack/claim backlog path,
not proposal-specific retry code. See [the notification chain](warp-notification-chain.md).
