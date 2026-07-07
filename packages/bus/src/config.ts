import type { ReactorConfig, ChainConfig } from './types';

// Hardcoded defaults for Phase 1
// DB-backed config is Phase 2 (future work order)
const DEFAULTS: Record<string, ReactorConfig[]> = {
  'identity.created': [
    { type: 'attestation', config: { attestationType: 'identity.created' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'identity.created' }, enabled: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  'identity.verified.preliminary': [
    { type: 'attestation', config: { attestationType: 'identity.verified.preliminary' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'identity.verified.preliminary' }, enabled: true },
  ],
  'identity.verified.hard': [
    { type: 'attestation', config: { attestationType: 'identity.verified.hard' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'identity.verified.hard' }, enabled: true },
  ],
  'identity.verified.steward': [
    { type: 'attestation', config: { attestationType: 'identity.verified.steward' }, enabled: true },
  ],
  'identity.verified.operator': [
    { type: 'attestation', config: { attestationType: 'identity.verified.operator' }, enabled: true },
  ],
  'connection.accepted': [
    { type: 'attestation', config: { attestationType: 'connection.accepted' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'connection.accepted' }, enabled: true },
    { type: 'notify', config: { template: 'invite_accepted' }, enabled: true },
  ],
  'vouch': [
    { type: 'attestation', config: { attestationType: 'vouch' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'vouch' }, enabled: true },
  ],
  'tip.granted': [
    { type: 'attestation', config: { attestationType: 'tip.granted' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'tip.granted' }, enabled: true },
    { type: 'notify', config: { scope: 'coffee:tip' }, enabled: true },
  ],
  'tip.sent': [
    { type: 'notify', config: { scope: 'coffee:tip-sent' }, enabled: true },
  ],
  'ticket.purchased': [
    { type: 'attestation', config: { attestationType: 'ticket.purchased' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'ticket.purchased' }, enabled: true },
    { type: 'notify', config: { scope: 'event:ticket' }, enabled: true },
  ],
  'ticket.receipt': [
    { type: 'notify', config: { scope: 'event:ticket-receipt' }, enabled: true },
  ],
  'ticket.confirmed': [
    { type: 'notify', config: { scope: 'event:ticket-confirmed' }, enabled: true },
  ],
  'ticket.reserved': [
    { type: 'notify', config: { scope: 'event:ticket-reserved' }, enabled: true },
  ],
  'ticket.refunded': [
    { type: 'notify', config: { scope: 'event:ticket-refunded' }, enabled: true },
  ],
  'ticket.registration.completed': [
    { type: 'notify', config: { scope: 'event:ticket-confirmed' }, enabled: true },
  ],
  'ticket.registration.reminder': [
    { type: 'notify', config: { scope: 'event:ticket-registration-reminder' }, enabled: true },
  ],
  'order.completed': [
    { type: 'settle', config: {}, await: true, enabled: true },
  ],
  'settlement.completed': [
    { type: 'emit', config: {}, enabled: true },
    {
      type: 'webhook',
      config: {
        url: `${process.env.EVENTS_SERVICE_URL || 'http://localhost:3006'}/api/webhook/settlement`,
        secret: process.env.WEBHOOK_SECRET,
      },
      enabled: !!process.env.EVENTS_SERVICE_URL,
    },
  ],
  'listing.purchased': [
    { type: 'attestation', config: { attestationType: 'listing.purchased' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'listing.purchased' }, enabled: true },
    { type: 'settle', config: {}, await: true, enabled: true },
    { type: 'notify', config: { scope: 'market:purchase' }, enabled: true },
  ],
  'attestation.created': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'group.created': [
    { type: 'attestation', config: { attestationType: 'group.created' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'group.created' }, enabled: true },
  ],
  'group.controller.added': [
    { type: 'attestation', config: { attestationType: 'group.member.added' }, enabled: true },
  ],
  'group.controller.removed': [
    { type: 'attestation', config: { attestationType: 'group.member.removed' }, enabled: true },
  ],
  'session.created': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'session.destroyed': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'scope.onboard': [
    { type: 'attestation', config: { attestationType: 'scope.onboard' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'scope.onboard' }, enabled: true },
  ],
  'message.send': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'conversation.create': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'group.member.left': [
    { type: 'attestation', config: { attestationType: 'group.member.left' }, enabled: true },
  ],
  'group.member.removed': [
    { type: 'attestation', config: { attestationType: 'group.member.removed' }, enabled: true },
  ],
  'group.member.added': [
    { type: 'attestation', config: { attestationType: 'group.member.added' }, enabled: true },
  ],
  'chat.mention': [
    { type: 'notify', config: { scope: 'chat:mention' }, enabled: true },
  ],
  'connection.disconnect': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'pod.member.added': [
    { type: 'attestation', config: { attestationType: 'pod.member.added' }, enabled: true },
  ],
  'pod.role.changed': [
    { type: 'attestation', config: { attestationType: 'pod.role.changed' }, enabled: true },
  ],
  'pod.member.removed': [
    { type: 'attestation', config: { attestationType: 'pod.member.removed' }, enabled: true },
  ],
  'pod.created': [
    { type: 'attestation', config: { attestationType: 'pod.created' }, enabled: true },
  ],
  'connection.invited': [
    { type: 'attestation', config: { attestationType: 'connection.invited' }, enabled: true },
  ],
  'payment.refund': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'payment.charge': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'fee.record': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'fee.rebate': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'fee.surcharge': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'customer': [
    { type: 'attestation', config: { attestationType: 'customer' }, enabled: true },
  ],
  'transaction.settled': [
    { type: 'attestation', config: { attestationType: 'transaction.settled' }, enabled: true },
  ],
  'handle.claimed': [
    { type: 'attestation', config: { attestationType: 'handle.claimed' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'handle.claimed' }, enabled: true },
  ],
  'profile.update': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'stub.created': [
    { type: 'attestation', config: { attestationType: 'stub.created' }, enabled: true },
  ],
  'bump.confirm': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'connection.create': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'bump.match': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'app.register': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'market.sale': [
    { type: 'notify', config: { scope: 'market:sale' }, enabled: true },
  ],
  'market.purchase': [
    { type: 'notify', config: { scope: 'market:purchase' }, enabled: true },
  ],
  'event.create': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'event.update': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'checkin.create': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'event.created': [
    { type: 'attestation', config: { attestationType: 'event.created' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'event.created' }, enabled: true },
  ],
  'event.attendance': [
    { type: 'attestation', config: { attestationType: 'event.attendance' }, enabled: true },
    { type: 'mjn', config: { attestationType: 'event.attendance' }, enabled: true },
  ],
  'event.registration': [
    { type: 'notify', config: { scope: 'event:registration' }, enabled: true },
  ],
  'event.rsvp': [
    { type: 'notify', config: {}, enabled: true },
  ],
  'ticket.purchase': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'learn.enrolled': [
    { type: 'attestation', config: { attestationType: 'learn.enrolled' }, enabled: true },
  ],
  'learn.completed': [
    { type: 'attestation', config: { attestationType: 'learn.completed' }, enabled: true },
  ],
  'listing.purchase': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'listing.update': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'listing.create': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'listing.created': [
    { type: 'attestation', config: { attestationType: 'listing.created' }, enabled: true },
    { type: 'notify', config: {}, enabled: true },
  ],
  'asset.fair.upgraded': [
    { type: 'attestation', config: { attestationType: 'asset.fair.upgraded' }, enabled: true },
  ],
  // #1205 — authored-document change trigger. #1207 attaches the release-gated
  // `project` reactor downstream (awaited so the projection is settled before
  // the write path returns). Kept in sync with migration 0059.
  'document.changed': [
    { type: 'emit', config: {}, enabled: true },
    { type: 'project', config: {}, await: true, enabled: true },
  ],
  'document.created': [
    { type: 'notify', config: { scope: 'auth:document-signature-request' }, enabled: true },
  ],
  'vault.secret.updated': [
    { type: 'vault-hot-reload', config: {}, enabled: true, await: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  'vault.secret.rotated': [
    { type: 'vault-hot-reload', config: {}, enabled: true, await: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  'vault.delegation.revoked': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'broker.release': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'broker.rejection': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'calendar.entry.created': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'calendar.entry.updated': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'calendar.entry.deleted': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'calendar.entry.expired': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'channel.link.created': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'channel.link.revoked': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'availability.intent.created': [
    { type: 'match-engine', config: {}, enabled: true },
  ],
  'availability.match.surfaced': [
    { type: 'emit', config: {}, enabled: true },
    { type: 'notify-match-delivery', config: {}, enabled: true },
  ],
  // calendar.entry.request: broker chain config seeded in migration 0054.
  // Hardcoded fallback mirrors calendar.availability.request (consent → scope → release → audit).
  // getBrokerChainConfig() reads from DB and never uses DEFAULTS, so this entry
  // is documentation-only — it will never be used at runtime.
  'calendar.entry.request': [
    { type: 'consent', config: {}, enabled: true },
    { type: 'scope', config: {}, enabled: true },
    { type: 'release', config: {}, enabled: true },
    { type: 'audit', config: {}, enabled: true },
  ],
};

// ---------------------------------------------------------------------------
// In-memory cache with 5-minute TTL
// ---------------------------------------------------------------------------

interface CacheEntry {
  config: ChainConfig | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function cacheKey(eventType: string, scope: string | null): string {
  return scope === null ? `${eventType}:null` : `${eventType}:${scope}`;
}

function getCached(key: string): ChainConfig | null | undefined {
  const entry = cache.get(key);
  if (entry === undefined) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.config;
}

function setCached(key: string, config: ChainConfig | null): void {
  cache.set(key, { config, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// DB-backed chain config lookup
// ---------------------------------------------------------------------------

import { createLogger } from '@imajin/logger';

const log = createLogger('bus:config');

export async function getChainConfig(eventType: string, scope: string): Promise<ChainConfig> {
  const dbConfig = await fetchChainConfigFromDb(eventType, scope);
  return dbConfig ?? makeFallbackConfig(eventType);
}

/**
 * Broker-chain variant of {@link getChainConfig}.
 *
 * Returns the DB-backed chain config for a broker event/scope, or `null` when
 * no row exists. Unlike {@link getChainConfig}, it does NOT fall back to the
 * publish-side {@link DEFAULTS} map — broker callers supply their own built-in
 * default chain (consent → scope → release → audit), so a publish default must
 * never leak into the broker pipeline.
 */
export async function getBrokerChainConfig(
  eventType: string,
  scope: string
): Promise<ChainConfig | null> {
  return fetchChainConfigFromDb(eventType, scope);
}

/**
 * Shared DB-backed chain config lookup (with cache).
 *
 * Returns the configured chain for {eventType, scope}, or `null` when no row
 * exists in `kernel.bus_chain_configs` (or the DB is unreachable). Callers
 * decide what fallback to apply.
 */
async function fetchChainConfigFromDb(
  eventType: string,
  scope: string
): Promise<ChainConfig | null> {
  const key = cacheKey(eventType, scope);
  const cached = getCached(key);
  if (cached !== undefined) {
    return cached;
  }

  let dbConfig: ChainConfig | null = null;

  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();

    // 1. Try scoped match first
    const scopedRows = await sql`
      SELECT reactors, enabled
      FROM kernel.bus_chain_configs
      WHERE event_type = ${eventType}
        AND scope = ${scope}
      LIMIT 1
    `;

    if (scopedRows.length > 0) {
      const row = scopedRows[0];
      dbConfig = {
        eventType,
        scope,
        reactors: row.enabled ? (row.reactors as ReactorConfig[]) : [],
      };
    } else {
      // 2. Fall back to node default (scope IS NULL)
      const defaultRows = await sql`
        SELECT reactors, enabled
        FROM kernel.bus_chain_configs
        WHERE event_type = ${eventType}
          AND scope IS NULL
        LIMIT 1
      `;

      if (defaultRows.length > 0) {
        const row = defaultRows[0];
        dbConfig = {
          eventType,
          scope: null,
          reactors: row.enabled ? (row.reactors as ReactorConfig[]) : [],
        };
      }
    }
  } catch (err) {
    log.warn(
      { err: String(err), eventType, scope },
      'DB query failed for chain config; falling back to hardcoded defaults'
    );
  }

  if (dbConfig !== null) {
    setCached(key, dbConfig);
    return dbConfig;
  }

  // No row found — cache the miss and let the caller choose a fallback.
  setCached(key, null);
  return null;
}

function makeFallbackConfig(eventType: string): ChainConfig {
  const reactors = DEFAULTS[eventType] || [];
  return {
    eventType,
    scope: null,
    reactors,
  };
}
