import { broker, isBrokerRelease } from '@imajin/bus';
import type { Logger } from '@imajin/logger';
import type { FieldVisibility } from '@/src/db/schemas/profile';

export const FIELD_VISIBILITY_LEVELS: string[] = ['public', 'connections', 'selective', 'private'];

/**
 * Apply per-field visibility rules to a profile's metadata for a non-owner requester (#1003).
 *
 * Visibility model (same shape as the calendar broker gate in
 * `apps/kernel/app/calendar/api/d/[did]/availability/route.ts`):
 *  - public / no rule → pass through
 *  - selective        → inline `allowedDids` check; drop if requester not listed
 *  - connections      → broker-gated via bus.broker('profile.field.request', ...).
 *                       Fail-closed: until a consent grant (#1049) admits the requester,
 *                       the broker rejects and the field stays sealed. Every request is audited.
 *  - private          → always drop
 *
 * Callers MUST bypass this for self-queries (owner sees everything).
 *
 * @param metadata - the subject profile's raw metadata
 * @param fieldVisibility - per-field disclosure rules
 * @param requesterDid - DID of the (non-owner) requester
 * @param subjectDid - DID of the profile owner (data subject), required for the broker call
 * @param log - logger for broker error reporting
 * @returns a filtered copy of metadata containing only fields the requester may see
 */
export async function filterProfileFields(
  metadata: Record<string, unknown> | null | undefined,
  fieldVisibility: FieldVisibility | null | undefined,
  requesterDid: string,
  subjectDid: string,
  log: Pick<Logger, 'error'>
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  if (!metadata) return result;

  const rules = fieldVisibility ?? {};
  const gatedFields: string[] = [];

  for (const [field, value] of Object.entries(metadata)) {
    const rule = rules[field];

    // public or no rule: pass through
    if (!rule || rule.level === 'public') {
      result[field] = value;
      continue;
    }

    // private: always drop
    if (rule.level === 'private') {
      continue;
    }

    // selective: inline allowedDids check
    if (rule.level === 'selective') {
      if (rule.allowedDids?.includes(requesterDid)) {
        result[field] = value;
      }
      continue;
    }

    // connections: defer to the broker gate (fail-closed)
    if (rule.level === 'connections') {
      gatedFields.push(field);
    }
  }

  // Gate connections-level fields through the broker in a single request. Fail-closed by default.
  if (gatedFields.length > 0) {
    try {
      const gatedData: Record<string, unknown> = {};
      for (const field of gatedFields) gatedData[field] = metadata[field];

      const release = await broker('profile.field.request', {
        type: 'profile.field.request',
        requester: requesterDid,
        subject: subjectDid,
        fields: gatedFields,
        purpose: 'profile.field',
        scope: 'profile',
        data: gatedData,
      });

      if (isBrokerRelease(release)) {
        for (const [field, value] of Object.entries(release.data)) {
          result[field] = value;
        }
      }
    } catch (err: unknown) {
      // Fail-closed: on any broker error, gated fields stay sealed.
      log.error({ err: String(err) }, 'profile.field.request broker gate error');
    }
  }

  return result;
}
