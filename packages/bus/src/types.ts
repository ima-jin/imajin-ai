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
    subjectDid: string;
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
  'handle.claimed': {
    handle: string;
    context_id: string;
    context_type: string;
  };
  'profile.update': {
    profileDid: string;
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
    ticketTypeId: string;
    quantity: number;
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
  'broker.release': {
    releaseId: string;
    requester: string;
    subject: string;
    fields: string[];
    purpose: string;
    scope: string;
    mode: 'attestation' | 'raw';
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
}

export type BusEventType = keyof BusEventMap;

// ============================================================================
// Broker types — consent-gated data release (#1014)
// ============================================================================

/** Broker request — asks for consented field release */
export interface BrokerRequest<T extends BrokerEventType = BrokerEventType> {
  type: T;
  requester: string;        // DID of the requester
  subject: string;          // DID of the data subject
  fields: string[];         // requested field names
  purpose: string;          // declared purpose
  scope: string;            // service scope
  data?: Record<string, unknown>; // subject data to filter (Phase 1: inline)
  preview?: boolean;        // dry-run mode
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
    mode: 'attestation' | 'raw';
  };
  preview?: boolean;
}

/** Rejection */
export interface BrokerRejection {
  status: 'rejected';
  reason: BrokerRejectionReason;
  fields?: string[];
  details?: string;
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
  mode?: 'attestation' | 'raw';
  consentReference?: string;
  // resolved by scope reactor
  filteredData?: Record<string, unknown>;
  // resolved by release reactor
  envelope?: BrokerRelease['envelope'];
}

/** Broker reactor signature — sync/awaited, returns updated state or rejection */
export type BrokerReactor = (
  state: BrokerPipelineState
) => Promise<BrokerPipelineState | BrokerRejection>;

/** Broker event types (Phase 1) */
export type BrokerEventType = string;
