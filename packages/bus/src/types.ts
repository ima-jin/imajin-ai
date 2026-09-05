export interface BusEvent {
  type: string;              // 'ticket.purchased', 'newsletter.sent', etc.
  issuer: string;            // DID of the actor
  subject: string;           // DID of the target
  scope: string;             // service scope ('events', 'pay', 'notify', etc.)
  payload?: Record<string, unknown>;
  correlationId?: string;    // trace across reactors
  timestamp?: string;        // ISO 8601, defaults to now
}

export interface ReactorConfig {
  type: string;              // 'attestation', 'emit', 'notify', 'settle', etc.
  config: Record<string, unknown>;  // type-specific config
  condition?: string;        // optional: future use for conditional execution
  await?: boolean;           // default false (fire-and-forget)
  enabled: boolean;
}

export interface ChainConfig {
  eventType: string;
  scope: string | null;      // null = node default
  reactors: ReactorConfig[];
  /** Where this chain came from — 'db' (kernel.bus_chain_configs row) or 'defaults' (hardcoded fallback map). */
  source: 'db' | 'defaults';
}

export type ReactorHandler = (event: BusEvent, config: Record<string, unknown>) => Promise<void>;

/** Type-safe event payloads — compiler catches bad call sites */
export interface BusEventMap {
  'identity.created': {
    did?: string;
    scope: string;
    subtype: string | null;
    tier: string;
    platformDid?: string;
    context_id: string;
    context_type: string;
  };
  'identity.verified.preliminary': {
    did?: string;
    scope: string;
    subtype: string | null;
    tier: string;
    context_id: string;
    context_type: string;
  };
  'identity.verified.hard': {
    context_id: string;
    context_type: string;
  };
  'identity.verified.steward': {
    did?: string;
    scope: string;
    subtype: string | null;
    tier: string;
    context_id: string;
    context_type: string;
  };
  'identity.verified.operator': {
    did?: string;
    scope: string;
    subtype: string | null;
    tier: string;
    context_id: string;
    context_type: string;
  };
  'identity.member_added': {
    context_id: string;
    context_type: string;
  };
  /** Envelope provisioner (#1933): fired once a provision reaches 'envelope_rendered' or later. */
  'agent.provisioned': {
    provisionId: string;
    agentDid: string;
    servingDid: string;
    harness: string;
    placement: 'hosted' | 'local';
    status: string;
  };
  'connection.accepted': {
    invite_code?: string;
    context_id: string;
    context_type: string;
    name?: string;
    notifyEmail?: string;
    email?: string;
    source?: string;
    match_id?: string;
    node_id?: string;
    node_name?: string;
  };
  'vouch': {
    invite_code?: string;
    context_id: string;
    context_type: string;
    source?: string;
    match_id?: string;
    node_id?: string;
    node_name?: string;
  };
  'tip.granted': {
    amount: number;
    currency: string;
    context_id: string;
    context_type: string;
    tipperName?: string;
    interestDids?: string[];
  };
  'ticket.purchased': {
    ticketId: string;
    eventId: string;
    amount: number;
    currency: string;
    context_id: string;
    context_type: string;
    to?: string;
    interestDids?: string[];
  };
  'order.completed': {
    orderId: string;
    eventId: string;
    eventDid: string;
    buyerDid: string;
    amount: number;
    currency: string;
    fairManifest: Record<string, unknown> | null;
    ticketIds?: string[];
    ticketTypeId?: string;
    stripeSessionId?: string;
    funded: boolean;
    funded_provider: string;
    email?: string;
    eventTitle?: string;
    ticketType?: string;
    metadata?: Record<string, unknown>;
  };
  'settlement.completed': {
    orderId: string;
    eventId: string;
    buyerDid: string;
    amount: number;
    currency: string;
    totalAmount: number;
    netAmount: number;
    fees: Array<{ role: string; name: string; rateBps: number; fixedCents: number; amount: number; estimated: boolean }>;
    chain: Array<{ did: string; amount: number; role: string }>;
    metadata?: Record<string, unknown>;
  };
  'listing.purchased': {
    context_id: string;
    context_type: string;
    amount: number;
    currency: string;
    fairManifest: Record<string, unknown> | null;
    funded: boolean;
    funded_provider: string;
    buyerDid: string;
    metadata: Record<string, unknown>;
    interestDids: string[];
  };
  'attestation.created': {
    attestationId: string;
    type: string;
    issuerDid: string;
    subjectDid: string;
    contextId: string | null;
    contextType: string | null;
    /** The calling app's origin (from the create request's `Origin` header), when derivable (#1820). */
    originUrl?: string;
    /**
     * True only when the attestation was created with an `author_jws` — i.e. it is
     * a bilateral attestation genuinely awaiting the subject's counter-signature.
     * The internal service-to-service creation path never accepts `author_jws`, so
     * this is always false there — that is what keeps the `attestation-notify`
     * reactor from firing for the many one-shot system attestations (identity,
     * vouch, ticket receipts, etc.) that also flow through this same event (#1820).
     */
    pendingSignature: boolean;
  };
  'group.created': {
    context_id: string;
    context_type: string;
    scope: string;
    name: string;
    handle: string | null;
  };
  'group.controller.added': {
    context_id: string;
    context_type: string;
    role: string;
    /** How the member arrived: 'direct' | 'invite' | 'agent' | 'claim' (#1680). */
    added_via?: string;
  };
  'group.controller.removed': {
    context_id: string;
    context_type: string;
  };
  'session.created': {
    tier: string;
  };
  'session.destroyed': Record<string, never>;
  'scope.onboard': {
    context_id: string;
    context_type: string;
  };
  'message.send': {
    conversationDid: string;
    messageId: string;
  };
  'conversation.create': {
    conversationDid: string;
    type: string;
    name?: string;
  };
  'group.member.left': {
    context_id: string;
    context_type: string;
  };
  'group.member.removed': {
    context_id: string;
    context_type: string;
  };
  'group.member.added': {
    context_id: string;
    context_type: string;
  };
  'chat.mention': {
    conversationId: string;
    messageId: string;
    senderName: string;
    messagePreview: string;
    interestDids?: string[];
  };
  'connection.disconnect': {
    otherDid: string;
  };
  'pod.member.added': {
    context_id: string;
    context_type: string;
    role?: string;
  };
  'pod.role.changed': {
    context_id: string;
    context_type: string;
    role: string;
  };
  'pod.member.removed': {
    context_id: string;
    context_type: string;
  };
  'pod.created': {
    context_id: string;
    context_type: string;
    name: string;
    type: string;
  };
  'connection.invited': {
    context_id: string;
    context_type: string;
    delivery: string;
  };
  'payment.refund': {
    paymentId: string;
    amount: number;
    reversalId: string;
    service: string;
  };
  'payment.charge': {
    paymentIntentId: string;
    amount: number;
    currency: string;
    service: string;
  };
  'fee.record': {
    transactionId: string;
    recipientDid: string;
    role: string;
    amountCents: number;
    currency: string;
  };
  'fee.rebate': {
    transactionId: string;
    sellerDid: string;
    amountCents: number;
    currency: string;
  };
  'fee.surcharge': {
    transactionId: string;
    sellerDid: string;
    amountCents: number;
    currency: string;
  };
  'customer': {
    role: string;
    context_id: string;
    context_type: string;
  };
  'transaction.settled': {
    total_amount: number;
    recipients: number;
    source: string;
    payerChainVerified: boolean;
    payeeChainVerified: boolean;
    context_id: string;
    context_type: string;
  };
  /**
   * The Stripe webhook's inline `.fair` manifest chain-distribution path
   * (#1073) attempted to verify the settling manifest's signature and it
   * was absent or invalid. This does NOT block settlement — the webhook
   * proceeds exactly as it always has — it only makes the gap loud and
   * durable (attestation) instead of silent, which is the one behavior
   * delta #1073 introduces on that path.
   */
  'settlement.manifest.unverified': {
    from_did: string;
    service: string;
    reason: string;
    context_id: string;
    context_type: string;
  };
  'handle.claimed': {
    handle: string;
    context_id: string;
    context_type: string;
  };
  'profile.update': {
    profileDid: string;
  };
  /**
   * A brokered field value for `subjectDid` changed (#1517).
   *
   * Consumed by the `broker-predicate-invalidation` reactor to revoke cached
   * predicate claims derived from those fields, so a claim cannot outlive the
   * value it was computed from.
   *
   * `subjectDid` is NOT required to be a profile DID. The reactor keys purely on
   * `(subject, field)` and nothing in the invalidation path is profile-specific,
   * so any surface that mutates a brokered field publishes this same event with
   * its own subject. The name is kept for the existing `bus_chain_configs` row
   * rather than renamed for accuracy; the contract is "a brokered field for this
   * subject changed".
   */
  'profile.field.changed': {
    subjectDid: string;
    fields: string[];
    context_id: string;
    context_type: 'profile';
  };
  'profile.field.request': {
    requester: string;
    subject: string;
    fields: string[];
    context_id: string;
    context_type: 'profile';
  };
  'stub.created': {
    name: string;
    handle: string | null;
    category: string | null;
    context_id: string;
    context_type: string;
  };
  'bump.confirm': {
    matchId: string;
    didA: string;
    didB: string;
  };
  'connection.create': {
    otherDid: string;
    source: string;
  };
  'bump.match': {
    matchId: string;
    otherDid: string;
    nodeId: string;
  };
  'app.register': {
    nodeId: string;
    hostname: string;
    buildHash: string;
  };
  'market.sale': {
    listingTitle?: string;
    amount: number;
    currency: string;
    buyerName?: string;
  };
  'market.purchase': {
    email?: string;
    listingTitle?: string;
    amount: number;
    currency: string;
  };
  'event.create': {
    eventId: string;
    eventDid: string;
    title: string;
  };
  'event.update': {
    eventId: string;
    status?: string;
  };
  'checkin.create': {
    eventId: string;
    ticketId: string;
    attendeeDid?: string;
  };
  'event.created': {
    eventDid: string;
    title: string;
    context_id: string;
    context_type: string;
  };
  'event.attendance': {
    ticketId: string;
    usedAt: Date | string;
    checkedInBy: string;
    context_id: string;
    context_type: string;
  };
  'event.registration': {
    eventTitle: string;
    email?: string;
    context_id: string;
    context_type: string;
  };
  'event.rsvp': {
    context_id: string;
    context_type: string;
    interestDids?: string[];
  };
  'ticket.purchase': {
    eventId: string;
    ticketTypeId?: string;
    quantity?: number;
    cart?: Array<{ ticketTypeId: string; quantity: number }>;
    totalQuantity?: number;
    sellerDid: string;
  };
  'learn.enrolled': {
    context_id: string;
    context_type: string;
    course_title: string;
    enrolled_at: string;
  };
  'learn.completed': {
    context_id: string;
    context_type: string;
    course_title: string;
    completed_at: string;
    modules_completed: number;
  };
  'tip.sent': {
    amount: number;
    currency: string;
    context_id: string;
    context_type: string;
    pageName?: string;
    interestDids?: string[];
  };
  'listing.purchase': {
    listingId: string;
    sellerDid: string;
    quantity: number;
  };
  'listing.update': {
    listingId: string;
  };
  'listing.create': {
    listingId: string;
    title: string;
    price: number;
  };
  'listing.created': {
    context_id: string;
    context_type: string;
    title: string;
    price: number;
    currency: string;
    interestDids?: string[];
  };
  'ticket.receipt': {
    email: string;
    buyerName?: string;
    eventTitle: string;
    eventDate: string;
    eventTime: string;
    ticketSummary: Array<{ typeName: string; quantity: number; unitPrice: string }>;
    totalPaid: string;
    paymentMethod: string;
    registrationUrl: string;
    eventImageUrl?: string;
    hasRegistrationRequired?: boolean;
    context_id: string;
    context_type: string;
  };
  'ticket.confirmed': {
    email: string;
    to?: string;
    eventTitle: string;
    eventDate: string;
    eventTime: string;
    isVirtual: boolean;
    venue?: string;
    price: string;
    magicLink?: string;
    eventImageUrl?: string;
    eventUrl?: string;
    tickets?: Array<{ id: string; qrCodeDataUri: string }>;
    ticketType?: string;
    ticketId?: string;
    qrCodeDataUri?: string;
    context_id: string;
    context_type: string;
  };
  'ticket.reserved': {
    email: string;
    eventTitle: string;
    eventDate: string;
    eventTime: string;
    ticketSummary: Array<{ typeName: string; quantity: number }>;
    totalQuantity: number;
    amount: string;
    payToEmail: string;
    memo: string;
    deadline: string;
    buyerEmail: string;
    myTicketsUrl: string;
    eventImageUrl?: string;
    context_id: string;
    context_type: string;
  };
  'ticket.refunded': {
    email: string;
    refundMessage: string;
    eventTitle: string;
    eventImageUrl?: string | null;
    eventUrl?: string;
    manualRefundRequired?: boolean;
    context_id: string;
    context_type: string;
  };
  'order.refunded': {
    orderId: string;
    eventId: string;
    ticketIds: string[];
    amountTotal: number;
    currency: string;
    isStripe: boolean;
  };
  'ticket.registration.completed': {
    email: string;
    eventTitle: string;
    eventDate: string;
    eventTime: string;
    isVirtual: boolean;
    venue?: string;
    price: string;
    magicLink: string;
    eventImageUrl?: string;
    eventUrl?: string;
    tickets?: Array<{ id: string; qrCodeDataUri: string }>;
    ticketType?: string;
    ticketId?: string;
    qrCodeDataUri?: string;
    context_id: string;
    context_type: string;
  };
  'ticket.registration.reminder': {
    email: string;
    eventTitle: string;
    eventDate: string;
    pendingCount: number;
    registrationUrl: string;
    eventImageUrl?: string;
    context_id: string;
    context_type: string;
  };
  'asset.fair.upgraded': {
    assetId: string;
    oldVersion: string;
    newVersion: string;
    signer: string;
  };
  'document.created': {
    attestationId: string;
    documentAssetId: string;
    creatorDid: string;
    creatorName?: string;
    signerDids: string[];
    title?: string;
    signUrl?: string;
    context_id: string;
    context_type: string;
  };
  'document.signed': {
    attestationId: string;
    signerDid: string;
    documentAssetId: string;
    context_id: string;
    context_type: string;
  };
  'document.executed': {
    attestationId: string;
    documentAssetId: string;
    creatorDid: string;
    signerDids: string[];
    context_id: string;
    context_type: string;
  };
  'document.declined': {
    attestationId: string;
    signerDid: string;
    documentAssetId: string;
    context_id: string;
    context_type: string;
  };
  'vault.secret.updated': {
    field: string;
    cid: string;
    senderDid: string;
    context_id: string;
    context_type: 'vault';
  };
  'vault.secret.rotated': {
    field: string;
    cid: string;
    previousCid: string;
    senderDid: string;
    context_id: string;
    context_type: 'vault';
  };
  /** Emitted when a vault_delegation_grants row is revoked (#1242). */
  'vault.delegation.revoked': {
    grantId: string;
    field: string;
    subject: string;     // ownerDid
    grantedTo: string;   // nodeDid / agentDid
    context_id: string;
    context_type: 'vault.delegation';
  };
  /**
   * Emitted by sealAndStoreV2 in Tier 1 mode when the vault entry is written
   * but no delegation grant has been created yet (#1403).  The external owner
   * agent (imajin-cli vault serve) receives this event, recovers the field key
   * by unwrapping wrappedFieldKey/wrappedFieldKeyNonce using ownerXPriv +
   * nodeXPub, then re-wraps it to nodeXPub (the canonical grant), signs, and
   * POSTs to POST /api/vault/delegation/grant.
   *
   * wrappedFieldKey: wrapFieldKey(fieldKey, ownerXPub, nodeXPriv)
   * Only the owner who holds ownerXPriv can recover the raw field key.
   */
  'vault.grant.requested': {
    field: string;                 // vault field name, e.g. 'GH_TOKEN'
    nodeXPub: string;              // node's X25519 pubkey (owner wraps the canonical grant to this)
    nodeDid: string;               // node's DID
    keyId: string;                 // correlates with the vault entry
    requestId: string;             // UUID from vault_grant_requests.request_id
    wrappedFieldKey: string;       // base64: fieldKey ECDH-wrapped nodeXPriv→ownerXPub
    wrappedFieldKeyNonce: string;  // base64: 12-byte AES-GCM nonce for the above
    ownerXPub: string;             // expected owner's X25519 pubkey (must match VAULT_OWNER_X_PUB)
    expiresAt: string | null;
    /**
     * The custody pair the owner agent is being asked to sign (#1603).
     *
     * For the node's own secrets both are `nodeDid` (a self-grant). For a
     * static-secret connector credential (#1439) `grantSubject` is the principal
     * who owns the key and `grantedTo` is the connector app DID.
     *
     * Named `grantSubject` rather than `subject` because the envelope already has
     * a `subject` field and they are not always the same DID.
     *
     * `grantedTo` authorizes; it is NOT the ECDH recipient. The field key is
     * always wrapped to `nodeXPub`.
     */
    grantSubject: string;
    grantedTo: string;
    context_id: string;
    context_type: 'vault';
  };
  /**
   * Emitted by POST /api/vault/delegation/grant when a Tier 1 delegation grant is
   * fulfilled by the external owner agent (#1403).  Prefer this over the generic
   * vault.secret.updated for consumers that specifically track grant lifecycle.
   */
  'vault.grant.fulfilled': {
    grantId: string;
    /**
     * Null for an owner-initiated renewal (#1535). A request row exists only to
     * deliver a field key the owner does not yet have; on renewal they already
     * hold it in an envelope, so there is nothing to correlate against.
     */
    requestId: string | null;
    field: string;
    subject: string;     // ownerDid
    grantedTo: string;   // nodeDid
    context_id: string;
    context_type: 'vault';
  };
  /**
   * Emitted when a DID dispatches a Warp cloud agent with its own sealed Warp
   * Agent key (#1428).
   *
   * This is the audit trail for individuated dispatch: `principalDid` is who
   * fired it and `configName` is the `{username}-jin` tag the run is stamped
   * with on Warp's side, so a run can be tied back to the credential that
   * created it.
   *
   * Deliberately carries NO prompt and NO credential material — the prompt can
   * contain anything the caller pasted, and events are persisted and fanned out
   * to reactors.
   */
  'warp.agent.dispatched': {
    runId: string;
    principalDid: string;
    /** Warp `config.name` the run was stamped with, e.g. `veteze-jin`. */
    configName: string;
    /** Lifecycle state Warp reported at creation, typically `QUEUED`. */
    state: string | null;
    skillSpec: string | null;
    environmentId: string | null;
    /**
     * Warp-confirmed conversation lineage (#1939): the conversation this run
     * continues, when the dispatch named one via `conversationId`.
     */
    conversationId: string | null;
    /**
     * Warp-confirmed orchestration lineage (#1939): the run that spawned this
     * one, when the dispatch named one via `parentRunId`. Read back from
     * Warp's own response rather than echoing the request, so the record
     * reflects what Warp actually accepted.
     */
    parentRunId: string | null;
    /**
     * What was retrieved from the principal's own corpus and prepended to the
     * prompt, when the dispatch named a `corpusContext` (#2021's "one real
     * consumer" checklist item). Null when the dispatch named none.
     *
     * Deliberately carries NO snippet text — only enough for a later reader to
     * see exactly what the agent was shown: which source/ref was searched, how
     * many hits, their content hashes (for a ref-pinned query, #1921), and when.
     */
    corpusContext: {
      source: string;
      ref?: string;
      hits: number;
      contentHashes: string[];
      retrievedAt: string;
    } | null;
    context_id: string;
    context_type: 'warp.agent';
  };
  /**
   * A terminal Warp run was resumed via cloud-to-cloud handoff (#1939).
   *
   * `send_followup`'s `resume: true` path proxies the follow-up to the same
   * `runId` — Warp continues it in place rather than spawning a new run — so
   * this is the honest record of *that a resume happened*, distinct from the
   * follow-up's own delivery. Published only on the resume path; an ordinary
   * mid-run follow-up publishes nothing extra.
   *
   * Deliberately NO prompt/message and NO credential material, the same
   * invariant as the rest of `warp.*`.
   */
  'warp.run.resumed': {
    runId: string;
    /** Who asked for the resume — the DID whose sealed key delivered it. */
    principalDid: string;
    /** The state the run was in before this resume, e.g. `SUCCEEDED`. */
    previousState: string | null;
    /**
     * The prior segment's `sessionId`, when known (#2032). This is what lets a
     * later terminal event (`warp.run.completed`/`warp.run.failed`) for the
     * resumed segment carry `resumedFrom` — the sweep reads the latest
     * `warp.run.resumed` row for a runId back out of the durable log rather
     * than re-deriving it.
     */
    previousSessionId: string | null;
    /**
     * The new segment's `sessionId`, when Warp had already rotated it by the
     * moment this was observed. Often null: Warp may not yet have started the
     * new segment when the follow-up is merely accepted, and nothing in the
     * segment-aware in-flight tracking (#2032) depends on this field — that
     * relies only on this event's own timestamp and `previousSessionId`.
     */
    newSessionId: string | null;
    /** The follow-up mode the resume was delivered with. */
    mode: string;
    resumedAt: string;
    context_id: string;
    context_type: 'warp.agent';
  };
  /**
   * A dispatched Warp run's in-request watch budget elapsed while Warp still
   * reports a non-terminal state (#2032).
   *
   * Replaces the old, misleading behaviour of publishing `warp.run.timeout`
   * (a terminal event) purely because the in-request watch's 30-minute
   * budget ran out — a run that later succeeds is not a timeout, and telling
   * the owner it was is the false-timeout bug this event exists to fix.
   *
   * Deliberately non-terminal and informational only: the run stays in the
   * sweep's in-flight set (no terminal row is written), so
   * `run-watch-sweep.ts` keeps checking it on its own schedule until it
   * actually reaches a terminal state — see `warp.run.completed` /
   * `warp.run.failed` — or the sweep's own `SWEEP_LOOKBACK_MS` elapses with
   * still no terminal state, which is what `warp.run.timeout` is now
   * reserved for.
   */
  'warp.run.still_running': {
    runId: string;
    /** Who dispatched it — the DID whose sealed key fired and watched the run. */
    principalDid: string;
    /** Last known lifecycle state when the watch budget elapsed, e.g. `INPROGRESS`. */
    state: string | null;
    /** How long the watch actually ran before giving up, in ms. */
    elapsedMs: number;
    /** The watch budget that elapsed (normally `WATCH_TIMEOUT_MS`). */
    watchBudgetMs: number;
    observedAt: string;
    context_id: string;
    context_type: 'warp.agent';
  };
  /**
   * A dispatched Warp run reached a terminal state (#1639, Stage 3).
   *
   * Warp has no webhooks, so the kernel watches the run it dispatched and
   * publishes this when it stops. Together with `warp.agent.dispatched` — same
   * `context_id` (the run id), same `context_type` — it closes the audit loop: an
   * orchestrating agent learns the outcome from the bus instead of polling.
   *
   * Carries everything a listener needs without a follow-up read: which dispatch
   * this completes (`runId` / `principalDid`), whether it worked (`state`, plus
   * `statusMessage.errorCode` when it did not), what it produced (`artifacts`,
   * which is where a PULL_REQUEST url and branch live), and what it cost
   * (`runTime`, `requestUsage`).
   *
   * Carries NO prompt, NO transcript, and NO credential material — same
   * invariant as `warp.agent.dispatched`, because events are persisted and fanned
   * out to reactors.
   */
  'warp.run.completed': {
    runId: string;
    /**
     * The terminal state.
     *
     * `FAILED` moved to its own event, `warp.run.failed` (#1838), so a
     * listener that only cares about failures does not have to inspect this
     * field on the shared "it stopped" event. `CANCELLED` stays here
     * alongside Warp's natural SUCCEEDED ending: a cancelled run is just as
     * finished, and reporting it as a completion is honest where watching it
     * for another 30 minutes and then claiming a timeout would not be.
     */
    state: 'SUCCEEDED' | 'CANCELLED';
    title: string | null;
    /** Warp `config.name`, e.g. `veteze-jin` — the dispatching credential's tag. */
    configName: string | null;
    /** Server-computed ISO-8601 duration, e.g. `PT2M30S`. */
    runTime: string | null;
    /**
     * Why the run ended where it did. `retryable` is nullable because Warp only
     * states it on some terminal errors, and inventing `false` for "unstated"
     * would tell a listener not to retry something Warp never ruled out.
     */
    statusMessage: { message: string; errorCode: string | null; retryable: boolean | null } | null;
    requestUsage: { inferenceCost: number | null; computeCost: number | null; platformCost: number | null } | null;
    /**
     * What the run produced, flattened to the fields a listener acts on. `type`
     * is Warp's `artifact_type` (`PULL_REQUEST`, `PLAN`, …) and `url`/`branch`
     * are lifted out of its per-type `data` when present.
     */
    artifacts: Array<{ type: string; url: string | null; branch: string | null }>;
    sessionLink: string | null;
    /** Who dispatched it — the DID whose sealed key fired and watched the run. */
    principalDid: string;
    completedAt: string;
    /**
     * The prior segment's `sessionId`, present only when this completion is
     * for a run that was resumed via `send_followup resume: true` (#2032).
     * Absent for an ordinary single-segment run — existing consumers that
     * never look at this field see no change.
     */
    resumedFrom?: string | null;
    /**
     * 1-based count of segments this run has run as, when it has ever been
     * resumed (#2032): 1 is the original dispatch, 2 is after the first
     * resume, and so on. Absent for an ordinary single-segment run.
     */
    segment?: number;
    context_id: string;
    context_type: 'warp.agent';
  };
  /**
   * A dispatched Warp run ended in FAILED (#1838).
   *
   * Split out of `warp.run.completed` so a failure notification does not
   * require inspecting `state` on a shared "ended" event — a subscriber that
   * only wants failures just subscribes to this type. `summary` is a flat
   * scalar (Warp's `errorCode`, falling back to the raw message) because the
   * notify reactor only substitutes flat payload keys, the same reason
   * `warp.run.progress` carries its own `summary` (#1682) — see
   * packages/bus/src/reactors/notify.ts.
   *
   * Same NO prompt / NO transcript / NO credential material invariant as the
   * rest of `warp.*`.
   */
  'warp.run.failed': {
    runId: string;
    state: 'FAILED';
    title: string | null;
    configName: string | null;
    runTime: string | null;
    statusMessage: { message: string; errorCode: string | null; retryable: boolean | null } | null;
    /** Flat one-line reason, for the notify reactor's `{{summary}}` substitution. */
    summary: string;
    requestUsage: { inferenceCost: number | null; computeCost: number | null; platformCost: number | null } | null;
    artifacts: Array<{ type: string; url: string | null; branch: string | null }>;
    sessionLink: string | null;
    principalDid: string;
    failedAt: string;
    /** Same resume-segment enrichment as `warp.run.completed` (#2032). */
    resumedFrom?: string | null;
    /** Same resume-segment enrichment as `warp.run.completed` (#2032). */
    segment?: number;
    context_id: string;
    context_type: 'warp.agent';
  };
  /**
   * A dispatched Warp run entered BLOCKED — waiting on a human, not finished
   * (#1838).
   *
   * Published the moment the watch (or the fallback sweep) observes the
   * transition, NOT at the 30-minute watch timeout: BLOCKED is the state most
   * likely to need a human nudge (e.g. missing repo access), and the bug this
   * issue exists for was exactly a run sitting BLOCKED for 40+ minutes with
   * nothing surfacing it.
   *
   * Deliberately NOT a terminal event — the run may resume once a human
   * resolves the block, so the watch keeps checking afterwards instead of
   * treating this as an ending.
   */
  'warp.run.blocked': {
    runId: string;
    state: 'BLOCKED';
    title: string | null;
    configName: string | null;
    statusMessage: { message: string; errorCode: string | null; retryable: boolean | null } | null;
    /** Flat one-line reason, for the notify reactor's `{{summary}}` substitution. */
    summary: string;
    artifacts: Array<{ type: string; url: string | null; branch: string | null }>;
    sessionLink: string | null;
    principalDid: string;
    blockedAt: string;
    context_id: string;
    context_type: 'warp.agent';
  };
  /**
   * A watched Warp run moved while it was still running (#1682).
   *
   * `warp.run.completed` closed the loop on a run *ending*; this closes it on a
   * run *happening*. The watch already reads the run every poll, so the deltas
   * were being observed and thrown away — a 30-minute run was 30 minutes of
   * silence for anything downstream.
   *
   * Published only when something actually changed since the previous poll, so a
   * quiet run stays quiet: `changed` names what moved, which is what lets a
   * consumer wake on a new tool call and ignore a cost tick.
   *
   * Never published for a terminal state — that is `warp.run.completed`'s job,
   * and duplicating it here would make every run report its ending twice.
   *
   * Carries NO prompt and NO credential material, the same invariant as the rest
   * of `warp.*`. Conversation text is summarised and truncated rather than
   * passed through, because events are persisted and a run's messages are
   * unbounded.
   */
  'warp.run.progress': {
    runId: string;
    /** Who dispatched it — the DID whose sealed key fired and watches the run. */
    principalDid: string;
    /** The state observed on this poll, e.g. `INPROGRESS`. */
    state: string | null;
    /** The state observed on the previous poll; null on the first sighting. */
    previousState: string | null;
    /** What moved since the last progress event. Never empty. */
    changed: Array<'state' | 'messages' | 'usage' | 'statusMessage' | 'artifacts'>;
    /** One-line human summary, e.g. `QUEUED → INPROGRESS`. Notification body fodder. */
    summary: string;
    /**
     * Conversation messages seen since the last poll, summarised.
     *
     * Capped: a burst longer than the cap keeps the most recent messages and
     * reports the true size in `newMessageCount`, because the tail is what an
     * agent deciding whether to intervene needs.
     */
    newMessages: Array<{
      /** Position in the run's flattened message stream — monotonic across polls. */
      index: number;
      /** The step it belongs to, so delegated sub-steps stay distinguishable. */
      stepId: string | null;
      role: string;
      /** Distinct block types, in order: `text`, `action`, `action_result`, `event`. */
      blockTypes: string[];
      /** Tool/action names lifted out of `action` blocks. */
      actions: string[];
      /** Text blocks joined and truncated; null when the message carried none. */
      text: string | null;
    }>;
    /** How many new messages appeared. May exceed `newMessages.length` (cap). */
    newMessageCount: number;
    /** Running total of messages observed for this run. */
    totalMessageCount: number;
    /** Cost snapshot as of this poll — the running spend, not a delta. */
    requestUsage: { inferenceCost: number | null; computeCost: number | null; platformCost: number | null } | null;
    /**
     * Why the run is in the state it is in, when Warp populated it early.
     *
     * The same object shape as `warp.run.completed` rather than a bare string:
     * a mid-run error is only actionable with its `errorCode` and `retryable`.
     */
    statusMessage: { message: string; errorCode: string | null; retryable: boolean | null } | null;
    /** Artifacts so far — a PR can be opened long before the run ends. */
    artifacts: Array<{ type: string; url: string | null; branch: string | null }>;
    /** Successful run reads so far in this watch, starting at 1. */
    pollCount: number;
    observedAt: string;
    context_id: string;
    context_type: 'warp.agent';
  };
  /**
   * A dispatched Warp run never reached a terminal state within the sweep's
   * own lookback window (#1639, Stage 3; narrowed by #2032).
   *
   * Prior to #2032 this was published by the in-request watch purely because
   * its 30-minute budget elapsed — which produced false timeouts for any run
   * (build-class runs especially) that was still legitimately going. That
   * case is now `warp.run.still_running`, which is non-terminal and leaves
   * the run in the sweep's in-flight set.
   *
   * This event is reserved for the genuinely unresolved case: `run-watch-
   * sweep.ts`'s own `SWEEP_LOOKBACK_MS` has elapsed since the run's latest
   * activity (dispatch or resume) with still no terminal state observed —
   * i.e. nothing is ever going to report on this run again. `lastKnownState`
   * is the last state the sweep observed before giving up.
   */
  'warp.run.timeout': {
    runId: string;
    lastKnownState: string;
    principalDid: string;
    timedOutAt: string;
    context_id: string;
    context_type: 'warp.agent';
  };
  'broker.release': {
    releaseId: string;
    requester: string;
    subject: string;
    fields: string[];
    purpose: string;
    scope: string;
    mode: BrokerReleaseEnvelopeMode;
    fieldModes?: Record<string, BrokerFieldReleaseMode>;
    issuedAt: string;
  };
  'broker.rejection': {
    requester: string;
    subject: string;
    fields: string[];
    purpose: string;
    scope: string;
    reason: BrokerRejectionReason;
    details?: string;
  };
  'broker.consent.created': {
    consentId: string;
    subject: string;
    grantedTo: string | null;
    purpose: string;
    context_id: string;
    context_type: 'consent';
  };
  'broker.consent.revoked': {
    consentId: string;
    subject: string;
    grantedTo: string | null;
    purpose: string;
    context_id: string;
    context_type: 'consent';
  };
  'calendar.entry.created': {
    entryId: string;
    type: string;
    did: string;
    context_id: string;
    context_type: 'calendar';
  };
  'calendar.entry.updated': {
    entryId: string;
    type: string;
    did: string;
    context_id: string;
    context_type: 'calendar';
  };
  'calendar.entry.deleted': {
    entryId: string;
    type: string;
    did: string;
    context_id: string;
    context_type: 'calendar';
  };
  'calendar.entry.expired': {
    entryId: string;
    type: string;
    did: string;
    context_id: string;
    context_type: 'calendar';
  };
  'availability.intent.created': {
    intentId: string;
    did: string;
    reach: string;
    activityTags: string[];
    sensitiveTags: string[];
    context_id: string;
    context_type: 'calendar';
  };
  'channel.link.created': {
    linkId: string;
    channel: string;
    did: string;
    appDid: string;
    context_id: string;
    context_type: 'channel_link';
  };
  'channel.link.revoked': {
    linkId: string;
    channel: string;
    did: string;
    appDid: string;
    context_id: string;
    context_type: 'channel_link';
  };
  'availability.match.surfaced': {
    matchId: string;
    recipientDid: string;
    otherDid: string;
    overlapTags: string[];
    isSensitive: boolean;
    deliveryPolicy: 'named_nudge' | 'staged' | 'sensitive_staged';
    context_id: string;
    context_type: 'calendar';
  };
  'asset.article.published': {
    assetId: string;
    slug: string;
    title: string;
    status: string;
    date: string;
  };
  /**
   * Emitted by requireWriteGate() when a write tool has no live approval grant
   * and must wait for human authorization (#1366, #1370).
   * `risk` distinguishes additive writes (append) from state-mutating writes (mutate);
   * the /jin dashboard uses it to decide confirmation urgency.
   * issuer = ownerDid, subject = ownerDid, scope = 'github'.
   */
  'action.proposed': {
    proposalId: string;
    ownerDid: string;
    /** DID of the acting agent, if different from the owner */
    agentDid?: string;
    /** Connector scope, e.g. 'github:write' */
    scope: string;
    /** Tool name, e.g. 'github_update_issue' */
    tool: string;
    /** Write tier: append = additive/reversible; mutate = alters existing state */
    risk: 'append' | 'mutate';
    /** Human-readable write target, e.g. 'owner/repo#42' */
    target: string;
    /** Human-readable args summary */
    argsSummary: string;
    context_id: string;
    context_type: 'github';
  };
  /**
   * Emitted when the human approves a pending proposal via the confirm endpoint
   * (#1366). The ownerAuthorization is the signed record.
   * issuer = ownerDid, subject = ownerDid, scope = 'github'.
   */
  'action.approved': {
    proposalId: string;
    ownerDid: string;
    tool: string;
    target: string;
    /** ISO 8601 string, or null for single-call approvals */
    approvedUntil: string | null;
    ownerAuthorization: Record<string, unknown>;
    context_id: string;
    context_type: 'github';
  };
  /**
   * Emitted when the human denies a pending proposal via the /jin dashboard (#1429).
   * No ownerAuthorization is written; the tool call stays blocked.
   * issuer = ownerDid, subject = ownerDid, scope = 'github'.
   */
  'action.denied': {
    proposalId: string;
    ownerDid: string;
    tool: string;
    target: string;
    context_id: string;
    context_type: 'github';
  };
  /**
   * Emitted after a write action executes successfully under an approved grant
   * (#1366). Non-fatal bus publish.
   * issuer = ownerDid, subject = ownerDid, scope = 'github'.
   */
  'action.done': {
    proposalId: string;
    ownerDid: string;
    tool: string;
    target: string;
    context_id: string;
    context_type: 'github';
  };
  /** Emitted after a GitHub issue is created on behalf of a DID (#1228). Non-fatal. */
  'github.issue.created': {
    ownerDid: string;
    repo: string;
    issueNumber: number;
    issueUrl: string;
    context_id: string;
    context_type: 'github';
  };
  /** Emitted after a GitHub issue comment is created on behalf of a DID (#1228). Non-fatal. */
  'github.comment.created': {
    ownerDid: string;
    repo: string;
    issueNumber: number;
    commentId: number;
    commentUrl: string;
    context_id: string;
    context_type: 'github';
  };
  /** Emitted after a Discord message is posted on behalf of a DID (#18). Non-fatal. */
  'discord.message.posted': {
    ownerDid: string;
    channelId: string;
    messageId: string;
    context_id: string;
    context_type: 'discord';
  };
  /**
   * Emitted after a connector credential is purged and its channel_links grant
   * revoked (#1490). Non-fatal audit trail. `connector` identifies the
   * provider, e.g. `'github'`, `'discord'`, `'quickbooks'`.
   */
  'connector.disconnected': {
    ownerDid: string;
    /** Short connector id, e.g. 'github', 'discord', 'quickbooks'. */
    connector: string;
    context_id: string;
    context_type: string;
  };
  // #1205 — authored-document change trigger (the control-plane "button").
  // issuer=ownerDid, subject=<assetId/doc-id>, scope=<service scope>.
  // Emitted only for tracked authored doc classes, never hot-state writes.
  'document.changed': {
    path: string;
    cid: string;
    prevCid: string | null;
  };
  // #1134 — supply.* pre-sale provenance events (free stages, no settlement).
  // A lot is threaded declare -> collect -> process -> list via `lotId`; `priorCid`
  // links each stage to the prior stage's content-addressed record (provenance).
  'supply.declared': {
    lotId: string;
    supplierDid: string;
    commodity: string;
    quantity: number;
    unit: string;
    context_id: string;
    context_type: string;
  };
  'supply.collected': {
    lotId: string;
    supplierDid: string;
    commodity: string;
    quantity: number;
    unit: string;
    priorCid?: string;
    context_id: string;
    context_type: string;
  };
  'supply.processed': {
    lotId: string;
    supplierDid: string;
    commodity: string;
    quantity: number;
    unit: string;
    priorCid?: string;
    context_id: string;
    context_type: string;
  };
  'supply.listed': {
    lotId: string;
    supplierDid: string;
    commodity: string;
    quantity: number;
    unit: string;
    priorCid?: string;
    context_id: string;
    context_type: string;
  };
  // #1384 — delivery-receipt stage. commodity is a payload field (product-agnostic).
  // #1820 — supplierDid (issuer) records the delivery; recipientDid (subject) is
  // the counterparty being asked to countersign. recipientDid falls back to
  // supplierDid when the caller doesn't identify a distinct counterparty (a
  // self-attested receipt, same as the pre-#1820 behavior).
  'supply.received': {
    lotId: string;
    supplierDid: string;
    recipientDid: string;
    commodity: string;
    quantity: number;
    unit: string;
    priorCid?: string;
    context_id: string;
    context_type: string;
  };
  /**
   * Structured operational usage reported by an external tool, attributed to a
   * DID (#1677). This is the telemetry INGESTION pattern — sibling to the
   * credential patterns (`token-paste`, `oauth`, `static-secret`) the connector
   * framework already routes by `ingestionPattern`, except the payload is a
   * structured usage event rather than a credential.
   *
   * `issuer` is the reporting tool's own app DID (the connector), minted via
   * Delegated App Sessions (#244) — NOT the human. `subject` is the DID the
   * usage is attributed to (the delegating principal, resolved from the app's
   * own consent grant at ingestion, never trusted from the request body alone).
   * `scope` is the fixed service scope `'telemetry'`.
   *
   * `data` is validated at ingestion to be a flat object of primitive values
   * (see `validateTelemetryEventBatch` in apps/kernel) — deliberately generic
   * rather than keyed to one tool's metrics, since `schema` is what the
   * reporting tool uses to namespace its own fields (e.g. `usage.tokens`,
   * `usage.cost`, `usage.model`).
   */
  'telemetry.usage': {
    /** Delegated agent DID, when the connector itself is an agent acting for the principal (optional). */
    agent?: string;
    /** Namespaced schema key the reporting tool uses for this metric family, e.g. `usage.tokens`. */
    schema: string;
    /** Flat usage fields — primitive values only. */
    data: Record<string, unknown>;
    /** Optional correlation back to the reporting tool's own session/run id. */
    sessionRef?: string;
    context_id: string;
    context_type: 'telemetry';
  };
  /** Same envelope as `telemetry.usage`, for a reported operational error (#1677). */
  'telemetry.error': {
    agent?: string;
    schema: string;
    data: Record<string, unknown>;
    sessionRef?: string;
    context_id: string;
    context_type: 'telemetry';
  };
  /** Same envelope as `telemetry.usage`, for a reported lifecycle transition (#1677). */
  'telemetry.lifecycle': {
    agent?: string;
    schema: string;
    data: Record<string, unknown>;
    sessionRef?: string;
    context_id: string;
    context_type: 'telemetry';
  };
  /**
   * Emitted by the claim-stub-expiry cron sweep (#1841) when an unclaimed
   * stub's `auth.claim_stub_index.stub_status` is flipped `active ->
   * expired`. `subject` on the envelope is the tombstoned stub DID.
   *
   * Lets a future reminder-ladder consumer (catalyst-power/xprize#75/#82,
   * not yet built) cancel any last-second scheduled send for a stub that
   * just lapsed, without the sweep needing to know anything about the
   * ladder's own state.
   */
  'identity.stub.lapsed': {
    did: string;
    /** `auth.attestations.id` rows cascaded to `attestation_status = 'lapsed'` by this sweep. */
    lapsedAttestationIds: string[];
    /** `connections.invites.id` rows cascaded to `status = 'lapsed'` by this sweep. */
    lapsedInviteIds: string[];
    context_id: string;
    context_type: 'identity.stub';
  };
  /**
   * Generic consent-request primitive (#1817) — an external system asks a
   * principal to consent to one described action. Generalizes the inference
   * confirm gate (`pending_confirm` → Confirm tap = the signing event,
   * #1782/#1784/#1791) to any vocabulary: `kind` names the request type in the
   * requester's own vocabulary (e.g. `openclaw.exec_command`), `summary` is the
   * full human-readable description of exactly what will happen, and `detail`
   * is an optional structured payload the card may render alongside it.
   *
   * issuer = requesterDid (the app that raised it, gated on `consent:write`),
   * subject = approverDid (who must decide) — routed by the notify reactor to
   * the /jin confirm card via the #1644/#1645 WebSocket push rail.
   */
  'consent.requested': {
    requestId: string;
    requesterDid: string;
    approverDid: string;
    kind: string;
    summary: string;
    detail: Record<string, unknown> | null;
    expiresAt: string;
    context_id: string;
    context_type: 'consent_request';
  };
  /**
   * Emitted when the approver taps Approve/Reject on a `consent.requested`
   * card (#1817). The canvas tap IS the signing event: `attestationId`
   * references the kernel-witnessed decision record — issuer = approverDid —
   * that binds this outcome to the exact request it decided.
   *
   * issuer = approverDid, subject = requesterDid — emitted back on the bus for
   * the requesting system to consume. Never published for an expired request:
   * expiry resolves the record directly (status: 'expired'), never via a
   * decision event, so a consumer can trust that every `approval.decision` it
   * sees is a genuine human tap.
   */
  'approval.decision': {
    requestId: string;
    requesterDid: string;
    approverDid: string;
    kind: string;
    decision: 'approve' | 'reject';
    attestationId: string;
    decidedAt: string;
    context_id: string;
    context_type: 'consent_request';
  };
  /**
   * Stripe BYO-restricted-key connector events (#1785).
   *
   * Verified webhook deliveries from an owner's OWN Stripe account (Connect is
   * deliberately bypassed — see the connector's class doc) are republished
   * here, tagged with the owning principal DID (`ownerDid`, also `issuer` and
   * `subject` on the envelope) so reactors can compose against them
   * `onBehalfOf` that identity.
   *
   * #1073 settlement seam: this PR intentionally stops at the bus event. A
   * follow-up reactor can subscribe to these three types and route them to
   * the canonical `POST /api/settle`, the same way `.fair` manifests already
   * converge platform-funded settlements — that convergence is NOT built here
   * (see the connector's class doc for why).
   */
  'stripe.payment_intent.succeeded': {
    ownerDid: string;
    eventId: string;
    paymentIntentId: string;
    amount: number;
    currency: string;
    context_id: string;
    context_type: 'stripe';
  };
  'stripe.invoice.paid': {
    ownerDid: string;
    eventId: string;
    invoiceId: string;
    amountPaid: number;
    currency: string;
    context_id: string;
    context_type: 'stripe';
  };
  'stripe.payout.paid': {
    ownerDid: string;
    eventId: string;
    payoutId: string;
    amount: number;
    currency: string;
    arrivalDate: string | null;
    context_id: string;
    context_type: 'stripe';
  };
  /**
   * A resource was consumed, by an actor, on behalf of a principal (#1147,
   * #1148) — the Agent Resource-Accounting Layer's emitter/resource-agnostic
   * primitive. `issuer`/`subject` on the envelope carry `issuerDid`/
   * `actingFor`: the agent (this node) is who signs it, the principal is who
   * it's attributed to. Every record self-declares `attestationClass:
   * 'system'` (#1149 will formalize this as a first-class field; until then
   * it rides in the payload, same as every other field here) — a meter
   * recorded this, it is not an assertion by the agent.
   */
  'usage.incurred': {
    attestationClass: 'system';
    issuerDid: string;
    actingFor: string | null;
    /** Typed discriminator: 'model:*' | 'tool:*' | 'infra:*' | 'external:*'. */
    resource: string;
    quantity: number | null;
    unit: string | null;
    costEstimateUsd: number | null;
    /** Which emitter produced this row, e.g. 'inference-passthrough'. */
    source: string;
    usageId: string;
    ts: string;
    context_id: string;
    context_type: string;
  };
  /**
   * The daily clock-rollup over `usage.incurred` (#1148): one signed record
   * per (principal, window), resource-blind at the top level — the cron
   * that emits this never branches on what any individual `resource`
   * string means, it only sums what the rows already carry. Same
   * `attestationClass: 'system'` contract as `usage.incurred` itself.
   */
  'usage.rollup': {
    attestationClass: 'system';
    issuerDid: string;
    actingFor: string;
    windowStart: string;
    windowEnd: string;
    totalCostEstimateUsd: number;
    breakdown: Array<{
      resource: string;
      source: string;
      quantity: number | null;
      unit: string | null;
      costEstimateUsd: number;
    }>;
    source: string;
    context_id: string;
    context_type: string;
  };
}

export type BusEventType = keyof BusEventMap;

// ============================================================================
// Broker types — consent-gated data release (#1014)
// ============================================================================

/**
 * Broker enforcement mode (#1231).
 * - `enforce` (default): the broker decision gates the caller (existing behavior).
 * - `shadow`: run the identical consent → scope → release → audit pipeline and
 *   write a real (shadow-flagged) audit row, but the decision is advisory. The
 *   caller is told `enforced: false` and must not act on a rejection.
 *
 * Distinct from `preview`: preview is a dry-run that SKIPS release + audit;
 * shadow does ALL the work (including audit) but is non-binding.
 */
export type BrokerMode = 'enforce' | 'shadow';

/** Broker release form for an individual field. */
export type BrokerFieldReleaseMode = 'attestation' | 'raw';

/** Release envelope summary mode. `mixed` means field-level modes differ. */
export type BrokerReleaseEnvelopeMode = BrokerFieldReleaseMode | 'mixed';

/** Field-level consent metadata resolved by the consent reactor. */
export interface BrokerResolvedFieldGrant {
  field: string;
  mode: BrokerFieldReleaseMode;
  consentReference: string;
}

/** Fixed-vocabulary predicate request for attestation-mode fields (#1514). */
export interface BrokerPredicateRequest {
  predicate: 'eq' | 'gte' | 'lte' | 'is_empty' | 'contains' | 'overlaps';
  arg?: unknown;
}

/** Signed-claim payload shape returned instead of raw values in attestation mode. */
export interface BrokerPredicateClaim {
  field: string;
  predicate: BrokerPredicateRequest['predicate'];
  result: boolean;
  arg?: unknown;
  valueHash?: string;
  cacheKey: string;
  cached?: boolean;
  issuedAt: string;
  expiresAt: string;
  /**
   * Cache keys of the primitive claims this claim was composed from (#1514).
   *
   * `overlaps` is a composition over the warm `contains` cache, so it records
   * which primitives produced it — "booleans consuming booleans" provenance.
   *
   * Deliberately cache keys ONLY, never the per-primitive booleans: knowing
   * that *something* in the declared set matched is the disclosure the subject
   * consented to, whereas knowing *which* term matched would reveal a specific
   * value from the sovereign set. Match-without-disclosure holds at this seam.
   */
  composedFrom?: string[];
}

/** Broker request — asks for consented field release */
export interface BrokerRequest<T extends BrokerEventType = BrokerEventType> {
  type: T;
  requester: string;        // DID of the requester
  subject: string;          // DID of the data subject
  fields: string[];         // requested field names
  purpose: string;          // declared purpose
  scope: string;            // service scope
  data?: Record<string, unknown>; // subject data to filter (Phase 1: inline)
  /** Optional per-field predicates for computed attestation releases (#1514). */
  predicates?: Record<string, BrokerPredicateRequest | BrokerPredicateRequest[]>;
  preview?: boolean;        // dry-run mode
  mode?: BrokerMode;        // enforcement mode; defaults to 'enforce'
}

/** Successful release */
export interface BrokerRelease {
  status: 'released';
  data: Record<string, unknown>;
  envelope: {
    releaseId: string;
    scopeId: string;
    purpose: string;
    issuedAt: string;
    consentReference: string;
    mode: BrokerReleaseEnvelopeMode;   // release form — NOT the broker enforcement mode
    fieldModes?: Record<string, BrokerFieldReleaseMode>;
    consentReferences?: Record<string, string>;
  };
  preview?: boolean;
  enforced?: boolean;       // false in shadow mode — decision is advisory, not binding
}

/** Rejection */
export interface BrokerRejection {
  status: 'rejected';
  reason: BrokerRejectionReason;
  fields?: string[];
  details?: string;
  enforced?: boolean;       // false in shadow mode — rejection is advisory, do not gate the caller
}

export type BrokerRejectionReason =
  | 'no_consent'
  | 'consent_expired'
  | 'consent_revoked'
  | 'field_not_found'
  | 'purpose_mismatch'
  | 'requester_unauthorized';

/** Result of a broker call */
export type BrokerResult = BrokerRelease | BrokerRejection;

/** Type guard */
export function isBrokerRelease(r: BrokerResult): r is BrokerRelease {
  return r.status === 'released';
}

/** Type guard */
export function isBrokerRejection(r: BrokerResult): r is BrokerRejection {
  return r.status === 'rejected';
}

/** Pipeline state passed between broker reactors */
export interface BrokerPipelineState {
  request: BrokerRequest;
  // resolved by consent reactor
  allowedFields?: string[];
  mode?: BrokerReleaseEnvelopeMode;
  consentReference?: string;
  fieldGrants?: Record<string, BrokerResolvedFieldGrant>;
  // resolved by scope reactor
  filteredData?: Record<string, unknown>;
  /** Requester-facing claims, one per posed predicate. */
  predicateClaims?: BrokerPredicateClaim[];
  /**
   * Freshly evaluated primitive claims the release reactor should persist as
   * cache rows (#1515). Distinct from `predicateClaims`: a composed `overlaps`
   * claim is returned to the requester but NOT cached, while the per-term
   * `contains` primitives it decomposed into ARE cached and shared across
   * requesters.
   */
  predicateCacheWrites?: BrokerPredicateClaim[];
  // resolved by release reactor
  envelope?: BrokerRelease['envelope'];
}

/** Broker reactor signature — sync/awaited, returns updated state or rejection */
export type BrokerReactor = (
  state: BrokerPipelineState
) => Promise<BrokerPipelineState | BrokerRejection>;

/** Broker event types (Phase 1) */
export type BrokerEventType = string;
