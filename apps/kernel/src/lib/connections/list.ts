import { db, connections, nicknames } from '@/src/db';
import { eq, or, and, isNull, inArray } from 'drizzle-orm';
import { lookupIdentity } from '@/src/lib/kernel/lookup';

export interface ConnectionEntry {
  did: string;
  handle: string | null;
  name: string | null;
  nickname: string | null;
  connectedAt: Date;
}

/**
 * List the active connections for a given DID, enriched with identity handle/name
 * and any nickname the owner has assigned. Used by both the HTTP connections route
 * and the MCP connections_list tool (in-process, no HTTP self-call).
 */
export async function listConnections(did: string): Promise<ConnectionEntry[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        or(eq(connections.didA, did), eq(connections.didB, did)),
        isNull(connections.disconnectedAt)
      )
    );

  // Map so `did` is the OTHER person's DID
  const mapped = rows.map((row) => ({
    did: row.didA === did ? row.didB : row.didA,
    connectedAt: row.connectedAt,
  }));

  const targetDids = mapped.map((c) => c.did);
  const nicknameRows =
    targetDids.length > 0
      ? await db
          .select()
          .from(nicknames)
          .where(and(eq(nicknames.did, did), inArray(nicknames.target, targetDids)))
      : [];
  const nicknameMap = new Map(nicknameRows.map((n) => [n.target, n.nickname]));

  return Promise.all(
    mapped.map(async (conn) => {
      const nickname = nicknameMap.get(conn.did) ?? null;
      const identity = await lookupIdentity(conn.did);
      return {
        did: conn.did,
        handle: identity?.handle ?? null,
        name: identity?.name ?? null,
        nickname,
        connectedAt: conn.connectedAt,
      };
    })
  );
}
