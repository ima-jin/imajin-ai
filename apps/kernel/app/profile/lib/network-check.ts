import { getClient } from '@imajin/db';

/**
 * Check if viewerDid is within maxDepth connection hops of any member
 * of the given community/group identity.
 * Uses BFS via recursive CTE on connections.connections table.
 */
export async function isInMemberNetwork(
  communityDid: string,
  viewerDid: string,
  maxDepth: number = 2
): Promise<boolean> {
  const sql = getClient();

  const result = await sql`
    WITH RECURSIVE network AS (
      SELECT member_did AS did, 0 AS depth
      FROM auth.identity_members
      WHERE identity_did = ${communityDid} AND removed_at IS NULL

      UNION

      SELECT
        CASE WHEN c.did_a = n.did THEN c.did_b ELSE c.did_a END AS did,
        n.depth + 1
      FROM network n
      JOIN connections.connections c
        ON (c.did_a = n.did OR c.did_b = n.did) AND c.disconnected_at IS NULL
      WHERE n.depth < ${maxDepth}
    )
    SELECT 1 AS found FROM network WHERE did = ${viewerDid} LIMIT 1
  `;

  return result.length > 0;
}
