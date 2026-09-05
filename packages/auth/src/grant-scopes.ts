/**
 * Closed capability registry for scoped delegation grants (#1882).
 *
 * These are exactly the 16 scopes promoted from the MCP OAuth surface plus
 * the three kernel extensions settled in the 2026-08-30 Day-1 review.
 * Capabilities name actions only; resource targets belong in `audience`.
 *
 * `eventTypes` is data for the delegated event-subscription work in #1884.
 */
export const GRANT_SCOPE_REGISTRY = [
  { scope: 'media:read', origin: 'mcp', eventTypes: [] },
  { scope: 'media:write', origin: 'mcp', eventTypes: [] },
  { scope: 'media:share', origin: 'mcp', eventTypes: [] },
  { scope: 'connections:read', origin: 'mcp', eventTypes: ['connection.invited', 'connection.accepted'] },
  { scope: 'messages:read', origin: 'mcp', eventTypes: ['message.send', 'chat.mention'] },
  { scope: 'messages:write', origin: 'mcp', eventTypes: ['message.send'] },
  { scope: 'github:read', origin: 'mcp', eventTypes: ['github.issue.created', 'github.comment.created'] },
  { scope: 'github:write', origin: 'mcp', eventTypes: ['github.issue.created', 'github.comment.created'] },
  { scope: 'github:org', origin: 'mcp', eventTypes: ['action.proposed', 'action.approved', 'action.denied'] },
  { scope: 'github:actions', origin: 'mcp', eventTypes: ['action.proposed', 'action.done'] },
  // #2032: 'warp.run.resumed' and 'warp.run.still_running' were missing here even
  // though both are published (see apps/kernel/src/lib/warp/dispatch.ts) — without
  // an entitling scope, deliverToSubscribers() takes its fast path and never writes
  // the durable kernel.event_subscription_log row the sweep (run-watch-sweep.ts)
  // reads to find in-flight runs. That gap is *why* a resumed run's completion was
  // never observed: the resume event existed on the bus but nowhere durable.
  { scope: 'warp:dispatch', origin: 'mcp', eventTypes: ['warp.agent.dispatched', 'warp.run.progress', 'warp.run.completed', 'warp.run.failed', 'warp.run.blocked', 'warp.run.timeout', 'warp.run.resumed', 'warp.run.still_running'] },
  { scope: 'discovery:read', origin: 'mcp', eventTypes: [] },
  { scope: 'inference:read', origin: 'mcp', eventTypes: ['attestation.created'] },
  { scope: 'inference:write', origin: 'mcp', eventTypes: ['attestation.created'] },
  { scope: 'corpus:read', origin: 'mcp', eventTypes: [] },
  { scope: 'corpus:write', origin: 'mcp', eventTypes: [] },
  { scope: 'intros:propose', origin: 'kernel', eventTypes: ['availability.match.surfaced'] },
  { scope: 'events:read', origin: 'kernel', eventTypes: ['event.created', 'event.update', 'event.rsvp'] },
  { scope: 'contacts:read', origin: 'kernel', eventTypes: [] },
] as const satisfies readonly {
  scope: string;
  origin: 'mcp' | 'kernel';
  eventTypes: readonly string[];
}[];

export type GrantScope = (typeof GRANT_SCOPE_REGISTRY)[number]['scope'];
export const GRANT_SCOPE_GRAMMAR = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

const BY_SCOPE = new Map<string, (typeof GRANT_SCOPE_REGISTRY)[number]>(
  GRANT_SCOPE_REGISTRY.map((entry) => [entry.scope, entry]),
);

export function isKnownGrantScope(scope: string): scope is GrantScope {
  return BY_SCOPE.has(scope);
}

export function grantScopeEntry(scope: string) {
  return BY_SCOPE.get(scope);
}

export function allGrantScopes(): readonly GrantScope[] {
  return GRANT_SCOPE_REGISTRY.map((entry) => entry.scope);
}

export function validateGrantCapabilities(capabilities: readonly string[]): {
  valid: GrantScope[];
  invalid: string[];
} {
  const valid: GrantScope[] = [];
  const invalid: string[] = [];
  for (const capability of capabilities) {
    if (isKnownGrantScope(capability)) valid.push(capability);
    else invalid.push(capability);
  }
  return { valid, invalid };
}

export function eventTypesForGrantScopes(capabilities: readonly string[]): string[] {
  const eventTypes = new Set<string>();
  for (const capability of capabilities) {
    const entry = grantScopeEntry(capability);
    if (!entry) continue;
    for (const eventType of entry.eventTypes) eventTypes.add(eventType);
  }
  return [...eventTypes];
}
