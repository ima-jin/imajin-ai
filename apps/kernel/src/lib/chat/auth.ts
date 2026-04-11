export { requireAuth, optionalAuth } from "@imajin/auth";
export type { Identity, AuthResult, AuthError } from "@imajin/auth";

import { db, connections } from '@/src/db';
import { or, and, eq, isNull } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * Check if a DID is in the trust graph (has at least one connection)
 */
export async function isInGraph(did: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ didA: connections.didA })
      .from(connections)
      .where(
        and(
          or(eq(connections.didA, did), eq(connections.didB, did)),
          isNull(connections.disconnectedAt)
        )
      )
      .limit(1);

    return rows.length > 0;
  } catch (error) {
    log.error({ err: String(error) }, 'failed to check graph membership');
    return false;
  }
}

/**
 * Require graph membership (hard DID + at least one connection)
 */
export async function requireGraphMember(
  request: Request
): Promise<
  { identity: import("@imajin/auth").Identity } | { error: string; status: number }
> {
  const { requireAuth: auth } = await import("@imajin/auth");
  const authResult = await auth(request);

  if ("error" in authResult) return authResult;

  const { identity } = authResult;

  if (identity.tier === "soft") {
    return {
      error: "This action requires a full identity (hard DID)",
      status: 403,
    };
  }

  const inGraph = await isInGraph(identity.id);
  if (!inGraph) {
    return {
      error:
        "This action requires at least one connection in the trust graph",
      status: 403,
    };
  }

  return { identity };
}
