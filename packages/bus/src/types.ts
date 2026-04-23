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
  'connection.accepted': {
    invite_code: string;
    context_id: string;
    context_type: string;
    name: string;
    notifyEmail?: string;
    email?: string;
  };
  'vouch': {
    invite_code: string;
    context_id: string;
    context_type: string;
  };
  'tip.granted': {
    amount: number;
    currency: string;
    context_id: string;
    context_type: string;
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
}

export type BusEventType = keyof BusEventMap;
