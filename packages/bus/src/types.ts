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
