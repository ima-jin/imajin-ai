import { publish, broker, isBrokerRelease } from '@imajin/bus';
import type { Logger } from '@imajin/logger';
import type { CalendarEntry } from '@/src/db';

export const ENTRY_TYPES: string[] = ['availability', 'meeting', 'event', 'booking', 'reminder', 'block'];
export const VISIBILITIES: string[] = ['public', 'connections', 'selective', 'private', 'sealed'];

// ---------------------------------------------------------------------------
// Per-type defaults — enforced in POST /calendar/api/entries
// ---------------------------------------------------------------------------

/**
 * Derive the enforced visibility + visibilityDids for a given entry type.
 *
 * - reminder / block: always private regardless of caller input.
 * - meeting with participantDids in metadata: defaults to selective, copying
 *   participantDids → visibilityDids. Caller may override to 'private' only.
 * - all other types: pass callerVisibility through unchanged.
 *
 * Returns { visibility, visibilityDids } where visibilityDids is null when
 * the type doesn't drive it (caller-supplied visibilityDids still apply).
 */
export function enforceTypeDefaults(
  type: string,
  body: Record<string, unknown>,
  callerVisibility: string,
): { visibility: string; visibilityDids: string[] | null } {
  if (type === 'reminder' || type === 'block') {
    return { visibility: 'private', visibilityDids: null };
  }

  if (type === 'meeting') {
    const metadata =
      typeof body.metadata === 'object' && body.metadata !== null
        ? (body.metadata as Record<string, unknown>)
        : null;
    const participantDids = Array.isArray(metadata?.participantDids)
      ? (metadata!.participantDids as unknown[]).filter((d): d is string => typeof d === 'string')
      : null;

    if (participantDids && participantDids.length > 0 && callerVisibility !== 'private') {
      return { visibility: 'selective', visibilityDids: participantDids };
    }
  }

  return { visibility: callerVisibility, visibilityDids: null };
}

// ---------------------------------------------------------------------------
// Projected entry — minimal disclosure surface for cross-DID reads
// ---------------------------------------------------------------------------

export interface ProjectedEntry {
  id: string;
  type: string;
  title: string | null;
  activityTags: string[] | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

function projectEntry(entry: CalendarEntry): ProjectedEntry {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title ?? null,
    activityTags: entry.activityTags ?? null,
    startsAt: entry.startsAt ?? null,
    endsAt: entry.endsAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Visibility gate — shared by all cross-DID calendar read routes
// ---------------------------------------------------------------------------

const NON_DISCLOSABLE = new Set(['private', 'sealed']);

/**
 * Apply the full visibility pass logic for cross-DID calendar reads.
 *
 * - public     → returned directly, no broker call
 * - selective  → inline check against visibilityDids, no broker call
 * - connections → broker-gated via brokerEventType
 * - private / sealed → silently dropped, never touch broker
 *
 * The broker call for connections entries fail-closes until consent grants
 * (#1049) + relationship-class resolution (#1189) land.
 */
export async function filterAndGateEntries(
  entries: CalendarEntry[],
  requesterDid: string,
  subjectDid: string,
  brokerEventType: string,
  brokerPurpose: string,
  log: Pick<Logger, 'error'>,
): Promise<ProjectedEntry[]> {
  const disclosed: ProjectedEntry[] = [];

  for (const e of entries) {
    if (NON_DISCLOSABLE.has(e.visibility)) continue;

    if (e.visibility === 'public') {
      disclosed.push(projectEntry(e));
      continue;
    }

    if (e.visibility === 'selective') {
      if (e.visibilityDids?.includes(requesterDid)) {
        disclosed.push(projectEntry(e));
      }
      continue;
    }
  }

  // connections: broker-gate as a batch
  const connectionEntries = entries.filter((e) => e.visibility === 'connections');
  if (connectionEntries.length > 0) {
    try {
      const result = await broker(brokerEventType, {
        type: brokerEventType,
        requester: requesterDid,
        subject: subjectDid,
        fields: ['entries'],
        purpose: brokerPurpose,
        scope: 'calendar',
        data: { entries: connectionEntries.map(projectEntry) },
      });
      if (isBrokerRelease(result) && Array.isArray(result.data.entries)) {
        disclosed.push(...(result.data.entries as ProjectedEntry[]));
      }
    } catch (err: unknown) {
      log.error({ err: String(err) }, `${brokerEventType} broker call failed`);
    }
  }

  return disclosed;
}

// ---------------------------------------------------------------------------
// Connection grant lifecycle — auto-manage grantedToClass grants (#1189)
// ---------------------------------------------------------------------------

/**
 * Sync the `grantedToClass='connections'` consent grant for a calendar owner.
 *
 * Called fire-and-forget after any write that could change how many
 * `connections`-visibility entries the owner has.
 *
 * Logic:
 * - If the owner has ≥1 active `connections`-visibility entry → ensure an
 *   active `grantedToClass='connections'` grant exists for the given purpose.
 * - If the owner has 0 such entries → revoke the grant (if it exists).
 *
 * Purpose should match the broker event purpose used when querying entries:
 * - `'calendar.entry'` for /calendar/api/d/[did]/entries
 */
export function syncCalendarConnectionGrant(
  ownerDid: string,
  purpose: string,
  issuerId: string,
  log: Pick<Logger, 'error'>,
): void {
  _syncConnectionGrant(ownerDid, purpose, issuerId).catch((err: unknown) => {
    log.error({ err: String(err) }, 'syncCalendarConnectionGrant failed');
  });
}

async function _syncConnectionGrant(
  ownerDid: string,
  purpose: string,
  issuerId: string,
): Promise<void> {
  const { getClient } = await import('@imajin/db');
  const sql = getClient();

  // Count active connections-visibility entries for this owner.
  const countRows = await sql`
    SELECT COUNT(*) AS count
    FROM kernel.calendar_entries
    WHERE did = ${ownerDid}
      AND visibility = 'connections'
      AND (expires_at IS NULL OR expires_at > now())
  `;
  const count = Number.parseInt((countRows[0] as { count: string }).count, 10);

  // Look for an existing active class-based grant.
  const grantRows = await sql`
    SELECT id FROM kernel.consent_grants
    WHERE subject = ${ownerDid}
      AND granted_to IS NULL
      AND granted_to_class = 'connections'
      AND purpose = ${purpose}
      AND status = 'active'
    LIMIT 1
  `;
  const existingId = grantRows[0] ? (grantRows[0] as { id: string }).id : null;

  if (count > 0 && !existingId) {
    // Create the grant — upsert on id to handle rare concurrent inserts.
    const { randomUUID } = await import('node:crypto');
    const id = `consent_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const consentRef = `cg_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await sql`
      INSERT INTO kernel.consent_grants
        (id, subject, granted_to, granted_to_class, purpose, allowed_fields, mode, status, consent_ref)
      VALUES
        (${id}, ${ownerDid}, NULL, 'connections', ${purpose},
         ARRAY['entries'::text], 'attestation', 'active', ${consentRef})
      ON CONFLICT (id) DO NOTHING
    `;
  } else if (count === 0 && existingId) {
    // No more connections-visibility entries — revoke the grant.
    await sql`
      UPDATE kernel.consent_grants
      SET status = 'revoked', updated_at = now()
      WHERE id = ${existingId}
    `;
    // Emit broker.consent.revoked so downstream services can react.
    const { publish } = await import('@imajin/bus');
    publish('broker.consent.revoked', {
      issuer: issuerId,
      subject: ownerDid,
      scope: 'calendar',
      payload: {
        consentId: existingId,
        subject: ownerDid,
        grantedTo: null,
        purpose,
        context_id: existingId,
        context_type: 'consent',
      },
    }).catch(() => { /* fire-and-forget */ });
  }
}

// ---------------------------------------------------------------------------
// Bus event helper
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget calendar entry bus event.
 * Used by the owner CRUD routes to emit lifecycle events without blocking the response.
 */
export function publishCalendarEntry(
  eventType: 'calendar.entry.created' | 'calendar.entry.updated' | 'calendar.entry.deleted' | 'calendar.entry.expired',
  issuerId: string,
  did: string,
  entryId: string,
  entryType: string,
  log: Pick<Logger, 'error'>
): void {
  publish(eventType, {
    issuer: issuerId,
    subject: did,
    scope: 'calendar',
    payload: { entryId, type: entryType, did, context_id: entryId, context_type: 'calendar' },
  }).catch((err: unknown) => log.error({ err: String(err) }, `${eventType} emit error`));
}
