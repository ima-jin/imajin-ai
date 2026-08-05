import { createLogger } from '@imajin/logger';
import type { ReactorHandler } from '../types';

const log = createLogger('bus:broker:predicate-invalidation');

function changedFieldsFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const fields = (payload as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter((field): field is string => typeof field === 'string' && field.trim().length > 0);
}

/**
 * Invalidate cached broker predicate claims derived from changed profile fields.
 *
 * `auth.attestations` is the hot-path cache for signed predicate claims. Claims
 * are live only while `revoked_at IS NULL` and `expires_at` is in the future.
 * A profile mutation revokes matching `broker.release` predicate cache rows so
 * the next broker request re-evaluates against the new raw value.
 */
export const brokerPredicateInvalidationReactor: ReactorHandler = async (event) => {
  const fields = changedFieldsFromPayload(event.payload);
  if (fields.length === 0) return;

  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();
    await sql`
      UPDATE auth.attestations
      SET revoked_at = now()
      WHERE subject_did = ${event.subject}
        AND type = 'broker.release'
        AND context_type = 'broker.predicate'
        AND revoked_at IS NULL
        AND payload->>'field' = ANY(${fields})
    `;
  } catch (err: unknown) {
    log.error(
      { err: String(err), subject: event.subject, fields },
      'broker predicate cache invalidation failed'
    );
  }
};
