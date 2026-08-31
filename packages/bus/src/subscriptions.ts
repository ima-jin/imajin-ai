import { randomUUID } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import {
  allGrantScopes,
  audienceAllows,
  eventTypesForGrantScopes,
  type DelegationAudience,
} from '@imajin/auth';
import type { BusEvent } from './types';

const log = createLogger('bus:event-subscription');

/**
 * Grant-bound event-subscription fan-out for external agents (#1884).
 *
 * Deliberately NOT a registered reactor (see registry.ts / config.ts):
 * entitlement is derived from #1882's live grants, not from
 * `bus_chain_configs`, and several event types that grant scopes entitle
 * (e.g. `github.issue.created`, `action.proposed`) have no chain config at
 * all today. Wiring this through the chain-config mechanism would require
 * touching every entitleable event type's reactor list (and, for types with
 * an existing DB row, a migration to match) purely to add fan-out that has
 * nothing to do with what any individual chain already does. Calling this
 * unconditionally from `publish()` covers every event type uniformly with a
 * single, independently-testable code path.
 *
 * `#1882's scope→event mapping is owned by the scope definition, not this
 * issue` (#1881 Day-1 review item 2) — this module only ever *reads*
 * `GRANT_SCOPE_REGISTRY` via `eventTypesForGrantScopes`; it never defines or
 * extends the mapping.
 *
 * Two responsibilities, always in this order:
 *   1. Persist a durable row (`kernel.event_subscription_log`) for every
 *      event whose type ANY grant scope could entitle — this is what backs
 *      cursor-based catch-up (apps/kernel's
 *      `GET /auth/api/events/subscriptions/catchup`), independent of who is
 *      connected right now.
 *   2. Resolve currently active, unexpired grants entitled to this event
 *      (delivery-time check — #1882 item 5 / #1884 item 4: never a cache,
 *      never a stored subscription list) and push a live WS frame to each
 *      one via the existing internal `did-push` route
 *      (apps/kernel/ws-server.js), reusing the same authenticated channel
 *      agents already connect to via challenge-response (#1883).
 *
 * Fire-and-forget by contract, same as every other bus reactor: never
 * throws, and a delivery failure never blocks or fails the publish() call
 * that triggered it. A live-push failure is not fatal — the event is
 * already durable, so the agent catches up on reconnect.
 */

// Raw SQL via @imajin/db — packages/bus must not import apps/kernel's
// Drizzle schema (see packages/bus/AGENTS.md).
async function getSql() {
  const { getClient } = await import('@imajin/db');
  return getClient();
}

// Reverse index: eventType -> capabilities that entitle it. Built once,
// lazily, directly from packages/auth's GRANT_SCOPE_REGISTRY (via
// eventTypesForGrantScopes) — #1884 never defines this mapping, only reads
// it in the other direction.
let capabilitiesByEventType: Map<string, string[]> | null = null;

function capabilitiesEntitling(eventType: string): string[] {
  if (!capabilitiesByEventType) {
    const map = new Map<string, string[]>();
    for (const scope of allGrantScopes()) {
      for (const type of eventTypesForGrantScopes([scope])) {
        const list = map.get(type) ?? [];
        list.push(scope);
        map.set(type, list);
      }
    }
    capabilitiesByEventType = map;
  }
  return capabilitiesByEventType.get(eventType) ?? [];
}

/** Test-only escape hatch: the module-level cache survives across events on purpose. */
export function _resetCapabilitiesByEventTypeCacheForTests(): void {
  capabilitiesByEventType = null;
}

/** The frame delivered over the existing authenticated WS channel (did-push). */
export interface SubscriptionEventFrame {
  type: 'bus_event';
  /** Stable dedupe/idempotency key (#1884 — "every event carries a stable event ID for dedupe"). */
  id: string;
  /** Monotonic cursor for `?cursor=` catch-up. */
  cursor: string;
  eventType: string;
  issuer: string;
  subject: string;
  scope: string;
  payload: Record<string, unknown> | undefined;
  correlationId: string | null;
  occurredAt: string;
  /** Dual-stamp-compatible provenance: which grant entitled this delivery. */
  grantId: string;
}

interface GrantRow {
  agentDid: string;
  grantId: string;
  audience: DelegationAudience;
}

export async function deliverToSubscribers(event: BusEvent): Promise<void> {
  const capabilities = capabilitiesEntitling(event.type);
  // Fast path: no scope in the registry could ever entitle this event type,
  // so there is nothing to persist or deliver.
  if (capabilities.length === 0) return;

  const sql = await getSql();
  const id = randomUUID();
  const occurredAt = event.timestamp ? new Date(event.timestamp) : new Date();

  let seq: string;
  try {
    const rows = await sql`
      INSERT INTO kernel.event_subscription_log
        (id, event_type, issuer_did, subject_did, scope, payload, correlation_id, occurred_at)
      VALUES
        (${id}, ${event.type}, ${event.issuer}, ${event.subject}, ${event.scope},
         ${event.payload ? JSON.stringify(event.payload) : null}::jsonb,
         ${event.correlationId ?? null}, ${occurredAt.toISOString()})
      RETURNING seq
    `;
    seq = String((rows[0] as { seq: unknown } | undefined)?.seq ?? '');
  } catch (err) {
    log.error({ err: String(err), event: event.type }, 'event_subscription_log write failed');
    return;
  }

  let grantRows: GrantRow[];
  try {
    const rows = await sql`
      SELECT DISTINCT g.agent_did, g.id AS grant_id, g.audience
      FROM auth.delegation_grants g
      JOIN auth.delegation_grant_capabilities c ON c.grant_id = g.id
      WHERE g.status = 'active'
        AND g.expires_at > now()
        AND c.status = 'active'
        AND c.capability = ANY(${capabilities})
    `;
    grantRows = (rows as unknown as Array<{ agent_did: string; grant_id: string; audience: unknown }>).map((row) => ({
      agentDid: row.agent_did,
      grantId: row.grant_id,
      audience: row.audience as DelegationAudience,
    }));
  } catch (err) {
    // Fail closed: a lookup failure delivers to nobody, same invariant as
    // introspectGrant (#1882). The event is already durable, so no one is
    // permanently denied — a later catch-up read re-runs this same
    // resolution fresh.
    log.error({ err: String(err), event: event.type }, 'grant lookup for event-subscription failed');
    return;
  }

  // One push per agent, even if multiple active grants independently
  // entitle the same event — the client dedupes by `id` regardless, but
  // there is no reason to fan out more than once. Keep the first matching
  // grant as the delivery's provenance.
  const byAgent = new Map<string, GrantRow>();
  for (const row of grantRows) {
    if (!audienceAllows(row.audience, event.subject)) continue;
    if (!byAgent.has(row.agentDid)) byAgent.set(row.agentDid, row);
  }
  if (byAgent.size === 0) return;

  const authServiceUrl = process.env.AUTH_SERVICE_URL;
  const internalKey = process.env.AUTH_INTERNAL_API_KEY;
  if (!authServiceUrl || !internalKey) {
    log.warn(
      { event: event.type },
      'AUTH_SERVICE_URL/AUTH_INTERNAL_API_KEY not set — subscribers will only see this event via catch-up',
    );
    return;
  }

  await Promise.all(
    [...byAgent.values()].map(({ agentDid, grantId }) => {
      const frame: SubscriptionEventFrame = {
        type: 'bus_event',
        id,
        cursor: seq,
        eventType: event.type,
        issuer: event.issuer,
        subject: event.subject,
        scope: event.scope,
        payload: event.payload,
        correlationId: event.correlationId ?? null,
        occurredAt: occurredAt.toISOString(),
        grantId,
      };
      return fetch(`${authServiceUrl}/chat/api/internal/did-push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': internalKey },
        body: JSON.stringify({ targetDid: agentDid, event: frame }),
      }).catch((err: unknown) => {
        log.error(
          { err: String(err), agentDid, event: event.type },
          'Live event-subscription push failed (agent will catch up via cursor)',
        );
      });
    }),
  );
}
