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
}

export type BusEventType = keyof BusEventMap;
