import { publish } from '@imajin/bus';
import type { Logger } from '@imajin/logger';

export const ENTRY_TYPES: string[] = ['availability', 'meeting', 'event', 'booking', 'reminder', 'block'];
export const VISIBILITIES: string[] = ['public', 'connections', 'selective', 'private', 'sealed'];

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
