export { requireAuth, optionalAuth } from "@imajin/auth";
export type { Identity, AuthResult, AuthError } from "@imajin/auth";

/**
 * Check if a DID is in the trust graph (has at least one 2-person pod)
 */
async function isInGraph(did: string): Promise<boolean> {
  const { db, podMembers } = await import("../db/index");
  const { eq, and, isNull, sql } = await import("drizzle-orm");

  const userPodIds = db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(eq(podMembers.did, did), isNull(podMembers.removedAt)));

  const twoPersonPods = await db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(
      and(
        isNull(podMembers.removedAt),
        sql`${podMembers.podId} IN (${userPodIds})`
      )
    )
    .groupBy(podMembers.podId)
    .having(sql`count(*) = 2`);

  return twoPersonPods.length > 0;
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
