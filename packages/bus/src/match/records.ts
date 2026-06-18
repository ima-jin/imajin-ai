import { randomUUID } from 'node:crypto';
import { createLogger } from '@imajin/logger';

const log = createLogger('bus:match:records');

/**
 * Attempt to record a matched intent pair as spent-forever.
 *
 * Intents are canonically ordered (lesser id first) so (A,B) == (B,A).
 * Returns true if this is a NEW match (row inserted).
 * Returns false if the pair was already spent (UNIQUE conflict).
 */
export async function recordMatch(
  intentIdA: string,
  intentIdB: string,
  overlapTags: string[],
  sensitive: boolean
): Promise<boolean> {
  // Canonical order: ensures (A,B) and (B,A) hit the same UNIQUE row.
  const [ia, ib] = intentIdA < intentIdB
    ? [intentIdA, intentIdB]
    : [intentIdB, intentIdA];

  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();

    const rows = await sql`
      INSERT INTO kernel.match_records (id, intent_a, intent_b, overlap_tags, sensitive)
      VALUES (
        ${randomUUID()},
        ${ia},
        ${ib},
        ${overlapTags},
        ${sensitive}
      )
      ON CONFLICT (intent_a, intent_b) DO NOTHING
      RETURNING id
    `;

    if (rows.length > 0) {
      log.info({ intentA: ia, intentB: ib, overlapTags }, 'Match pair recorded (new)');
      return true;
    }

    log.info({ intentA: ia, intentB: ib }, 'Match pair already spent — skipping');
    return false;
  } catch (err) {
    log.error({ err: String(err), intentA: ia, intentB: ib }, 'Failed to record match pair');
    // Fail-closed: treat as already spent so we don't double-surface.
    return false;
  }
}

/**
 * Return the set of intent IDs already spent against a given intent.
 * Used by the candidate pre-filter to exclude already-matched intents.
 */
export async function getSpentIntents(intentId: string): Promise<Set<string>> {
  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();

    const rows = await sql<{ intent_a: string; intent_b: string }[]>`
      SELECT intent_a, intent_b
      FROM kernel.match_records
      WHERE intent_a = ${intentId} OR intent_b = ${intentId}
    `;

    const spent = new Set<string>();
    for (const row of rows) {
      spent.add(row.intent_a === intentId ? row.intent_b : row.intent_a);
    }
    return spent;
  } catch (err) {
    log.error({ err: String(err), intentId }, 'Failed to fetch spent intents');
    return new Set();
  }
}
