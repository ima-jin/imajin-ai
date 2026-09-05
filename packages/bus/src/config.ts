import type { ReactorConfig, ChainConfig } from './types';

/**
 * Shorthand for the single-`attestation`-reactor chain shape used by many
 * DEFAULTS entries below (#1073 — keeps the new `settlement.manifest.unverified`
 * entry from being a literal copy of `transaction.settled` et al.).
 */
function attestationOnly(attestationType: string): ReactorConfig[] {
  return [{ type: 'attestation', config: { attestationType }, enabled: true }];
}

/**
 * Shorthand for the `emit` + `notify` two-reactor chain shape used by several
 * `warp.run.*` entries below (#2032 — same reasoning as `attestationOnly`:
 * keeps two new, structurally-identical additions, `warp.run.resumed` and
 * `warp.run.still_running`, from flagging as code duplication).
 */
function emitAndNotify(title: string, body: string): ReactorConfig[] {
  return [
    { type: 'emit', config: {}, enabled: true },
    { type: 'notify', config: { title, body }, enabled: true },
  ];
}

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
  // #1375 / migration 0098 — supply-recorder runs first (awaited) to write the settled stage row
  // before settle executes the .fair split. The recorder is a no-op for non-supply
  // order.completed events (scope !== 'supply').
  'order.completed': [
    { type: 'supply-recorder', config: {}, await: true, enabled: true },
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
  // #1820 / migration 0098 — `attestation-notify` additionally routes to notify's send for the
  // subset of attestations that are genuinely awaiting the subject's
  // counter-signature (gated internally on payload.pendingSignature).
  // Kept in sync with migration 0098 — #1821 added `attestation-notify` here
  // but shipped no migration, so migration 0039's DB row (emit only) silently
  // shadowed this default until #1856/0096 caught the DB row up.
  'attestation.created': [
    { type: 'emit', config: {}, enabled: true },
    { type: 'attestation-notify', config: {}, enabled: true },
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
  // #1073 — non-blocking manifest-verification gap on the webhook settlement
  // path. `attestation` makes it a durable, queryable record instead of a
  // log line only; deliberately no `settle`/`notify` — this is a coherence
  // signal, not an action trigger.
  'settlement.manifest.unverified': attestationOnly('settlement.manifest.unverified'),
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
  // #1933 envelope provisioner — signed provisioning event, emit-only for now
  // (no attestation reactor yet; the provision record itself is the durable
  // record, kept in auth.agent_provisions).
  'agent.provisioned': [
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
  // #1841 — claim-stub-expiry sweep. `emit` puts the tombstone event on the
  // signed event stream; no `attestation`/`mjn` reactor since a lapsing
  // stub is a garbage-collection outcome, not an economic/identity event
  // worth signing (mirrors vault.delegation.revoked above).
  'identity.stub.lapsed': [
    { type: 'emit', config: {}, enabled: true },
  ],
  // #1639 Stage 3 — `emit` puts the outcome on the live event stream, so an
  // orchestrating agent is woken by a dispatched run finishing instead of polling
  // `get_run` for it. #1644 adds `notify`, which turns that into a durable
  // notification row AND a WebSocket push to the dispatching DID (the reactor
  // sends to `event.subject`, which watchRun() sets to that DID).
  // Kept in sync with migration 0084. A DB row in `kernel.bus_chain_configs`
  // REPLACES this list, which is why the migration repeats `emit`.
  'warp.run.completed': [
    { type: 'emit', config: {}, enabled: true },
    {
      type: 'notify',
      config: { title: 'Warp run completed', body: 'Run {{state}}: {{title}}' },
      enabled: true,
    },
  ],
  'warp.run.timeout': [
    { type: 'emit', config: {}, enabled: true },
    {
      type: 'notify',
      config: { title: 'Warp run timed out', body: 'Run {{runId}} last seen {{lastKnownState}}' },
      enabled: true,
    },
  ],
  // #2032 — a terminal run was resumed via cloud-to-cloud handoff. Previously
  // had no chain at all (an oversight from #1939): the event published but
  // nothing durable or human-visible came of it. `notify` mirrors the other
  // lifecycle transitions above; `emit` puts it on the same live stream.
  'warp.run.resumed': emitAndNotify('Warp run resumed', 'Run {{runId}} resumed from {{previousState}}'),
  // #2032 — the in-request watch's budget elapsed but Warp still reports a
  // non-terminal state. Replaces the old (mis-terminal) `warp.run.timeout`
  // notification for this case with an honest "still going" one; the sweep
  // keeps watching afterwards and the real terminal event follows later.
  'warp.run.still_running': emitAndNotify(
    'Warp run still running',
    'Run {{runId}} still {{state}} after {{elapsedMs}}ms — still watching',
  ),
  // #1838 — FAILED and BLOCKED get their own first-class notify chains rather
  // than sharing warp.run.completed's `state` field. `summary` is the flat
  // scalar the notify reactor's `{{field}}` substitution can read (it never
  // walks nested objects like `statusMessage`). Kept in sync with migration
  // 0109 for the same "DB row replaces this list" reason as warp.run.completed.
  'warp.run.failed': [
    { type: 'emit', config: {}, enabled: true },
    {
      type: 'notify',
      config: { title: 'Warp run failed', body: 'Run failed: {{title}} — {{summary}}' },
      enabled: true,
    },
  ],
  'warp.run.blocked': [
    { type: 'emit', config: {}, enabled: true },
    {
      type: 'notify',
      config: { title: 'Warp run blocked', body: 'Run blocked: {{title}} — {{summary}}' },
      enabled: true,
    },
  ],
  // #1682 — mid-run deltas, down the same pipe as the terminal events so the
  // signed event stream carries every observed change. #1805 reclassifies this
  // chain as telemetry-class: a parallel dispatch session was producing 99+
  // notification rows for pure operational exhaust (message-count ticks, cost
  // updates). `notify` is dropped here — `emit` stays so `registry.system_events`
  // (queryable per-DID via its `did` index) keeps receiving every tick for the
  // #1799 connector telemetry rollup. Terminal transitions (`warp.run.completed`,
  // `warp.run.timeout` above) are state transitions a human should see, so they
  // keep `notify` untouched. Kept in sync with migration 0090.
  'warp.run.progress': [
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
  // #1102 / migration 0098 — emit + notify-match-delivery for match-engine disclosures.
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
  // #1134 — supply.* pre-sale provenance stages (declared -> collected -> processed -> listed).
  // Free stages: NO `settle` reactor (that's the declarative "this stage is free").
  // The paid stage reuses `order.completed`, already configured above.
  // #1136 — `supply-recorder` (awaited, runs first) materializes the lot + stage
  // rows from the event's correlationId before the downstream reactors run.
  'supply.declared': [
    { type: 'supply-recorder', config: {}, await: true, enabled: true },
    { type: 'attestation', config: { attestationType: 'supply.declared' }, enabled: true },
    { type: 'emit', config: {}, enabled: true },
    { type: 'notify', config: { scope: 'supply:declared' }, enabled: true },
  ],
  'supply.collected': [
    { type: 'supply-recorder', config: {}, await: true, enabled: true },
    { type: 'attestation', config: { attestationType: 'supply.collected' }, enabled: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  'supply.processed': [
    { type: 'supply-recorder', config: {}, await: true, enabled: true },
    { type: 'attestation', config: { attestationType: 'supply.processed' }, enabled: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  'supply.listed': [
    { type: 'supply-recorder', config: {}, await: true, enabled: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  // #1384 — delivery-receipt stage. supply-recorder advances lot status to 'received'.
  // #1820 — `pending: true`: a supply.received attestation is a bilateral,
  // counterparty-signable claim (recipient countersigns to confirm receipt),
  // so the attestation reactor's `pendingSignature` gate must be open for it.
  // Harmless when there is no distinct counterparty (issuer === subject) since
  // the `attestation-notify` reactor's self-attestation skip still applies.
  'supply.received': [
    { type: 'supply-recorder', config: {}, await: true, enabled: true },
    { type: 'attestation', config: { attestationType: 'supply.received', pending: true }, enabled: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  // #1677 — telemetry ingestion pattern: structured usage events from external
  // tools, attributed to a DID. `audit-log` (#1140) gives the durable,
  // queryable-by-subject persistence record every reader (including the #1799
  // per-principal usage projection) reads from; `emit` puts it on
  // registry.system_events alongside every other bus event. Deliberately NO
  // `attestation` reactor — signing every usage tick would be prohibitively
  // expensive for what is, by design, high-frequency operational exhaust
  // (mirrors the #1805 rationale for dropping `notify` from warp.run.progress).
  'telemetry.usage': [
    { type: 'audit-log', config: {}, enabled: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  'telemetry.error': [
    { type: 'audit-log', config: {}, enabled: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  'telemetry.lifecycle': [
    { type: 'audit-log', config: {}, enabled: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  // #1817 — generic consent-request primitive. `notify` routes the approver's
  // /jin confirm card down the #1644/#1645 WebSocket push rail; `emit` puts it
  // on the signed event stream. Kept in sync with the seed migration.
  'consent.requested': [
    { type: 'emit', config: {}, enabled: true },
    {
      type: 'notify',
      config: { title: 'Consent requested: {{kind}}', body: '{{summary}}' },
      enabled: true,
    },
  ],
  // The decision is emitted back for the requesting system to consume off the
  // signed event stream — no human-facing notification is implied by the
  // primitive itself (the requester is typically a machine, not a /jin viewer).
  'approval.decision': [
    { type: 'emit', config: {}, enabled: true },
  ],
  // #1147/#1148 — Agent Resource-Accounting Layer's `usage.incurred` primitive.
  // "Bread is free" pattern: `attestation` writes the durable signed record,
  // `emit` makes it observable, deliberately NO `settle` (metered, not
  // billed). Kept in sync with migration 0120.
  'usage.incurred': [
    { type: 'attestation', config: { attestationType: 'usage.incurred' }, enabled: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  // #1148 — the daily clock-rollup's own signed record, one per (principal,
  // window). `await: true` on `attestation` only here (not on the per-call
  // usage.incurred above): this fires from an offline cron sweep, not a
  // live request path, so awaiting the signed write costs nothing and lets
  // the sweep report accurate published/skipped counts. Still no `settle`.
  // Kept in sync with migration 0120.
  'usage.rollup': [
    { type: 'attestation', config: { attestationType: 'usage.rollup' }, await: true, enabled: true },
    { type: 'emit', config: {}, enabled: true },
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
        source: 'db',
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
          source: 'db',
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
    source: 'defaults',
  };
}
