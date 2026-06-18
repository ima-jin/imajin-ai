import { createLogger } from '@imajin/logger';

const log = createLogger('bus:match:candidates');

export interface CandidateIntent {
  id: string;
  did: string;
  activityTags: string[];
  sensitiveTags: string[];
  reach: string;
  startsAt: Date | null;
  endsAt: Date | null;
  expiresAt: Date | null;
}

/**
 * SQL pre-filter: pull live availability intents that have at least one shared
 * activity tag with the arriver, excluding self and already-spent pairs.
 *
 * This is a cheap array-overlap (&&) pre-filter — the real set intersection and
 * reach/sensitivity checks happen in the engine. We cast the net wide here and
 * tighten it in subsequent steps.
 */
export async function findCandidates(
  arriverIntentId: string,
  arriverDid: string,
  arriverTags: string[],
  spentIntentIds: Set<string>
): Promise<CandidateIntent[]> {
  if (arriverTags.length === 0) {
    log.info({ arriverDid }, 'No activity tags — no candidates possible');
    return [];
  }

  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();

    // Exclude the arriver's own intent and already-spent pairs.
    const spentList = [arriverIntentId, ...Array.from(spentIntentIds)];

    const rows = await sql<{
      id: string;
      did: string;
      activity_tags: string[] | null;
      sensitive_tags: string[] | null;
      reach: string;
      starts_at: Date | null;
      ends_at: Date | null;
      expires_at: Date | null;
    }[]>`
      SELECT id, did, activity_tags, sensitive_tags, reach, starts_at, ends_at, expires_at
      FROM kernel.calendar_entries
      WHERE type = 'availability'
        AND visibility = 'sealed'
        AND expires_at > now()
        AND did != ${arriverDid}
        AND id != ALL(${spentList})
        AND (ends_at IS NULL OR ends_at > now())
        AND activity_tags && ${arriverTags}
    `;

    log.info(
      { arriverDid, candidateCount: rows.length },
      'Candidate pre-filter complete'
    );

    return rows.map((r) => ({
      id: r.id,
      did: r.did,
      activityTags: r.activity_tags ?? [],
      sensitiveTags: r.sensitive_tags ?? [],
      reach: r.reach,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      expiresAt: r.expires_at,
    }));
  } catch (err) {
    log.error({ err: String(err), arriverDid }, 'Candidate query failed');
    return [];
  }
}
