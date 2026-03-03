/**
 * Auth utilities - validate tokens against auth service
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export interface Identity {
  id: string;
  type: 'human' | 'agent';
  name?: string;
  tier?: 'soft' | 'hard';
}

export interface ValidateResult {
  valid: boolean;
  identity?: Identity;
}

export async function validateToken(token: string): Promise<ValidateResult> {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      return { valid: false };
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Token validation failed:', error);
    return { valid: false };
  }
}

export function extractToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return null;
  }
  return auth.slice(7);
}

export async function requireAuth(request: Request): Promise<{ identity: Identity } | { error: string; status: number }> {
  const token = extractToken(request);

  if (!token) {
    return { error: 'Missing authorization token', status: 401 };
  }

  const result = await validateToken(token);

  if (!result.valid || !result.identity) {
    return { error: 'Invalid or expired token', status: 401 };
  }

  return { identity: result.identity };
}

/**
 * Check if a DID is in the trust graph (has at least one connection)
 */
async function isInGraph(did: string): Promise<boolean> {
  const { db, podMembers } = await import('../db/index');
  const { eq, and, isNull, sql } = await import('drizzle-orm');

  // Find all pods this user is in
  const userPodIds = db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(eq(podMembers.did, did), isNull(podMembers.removedAt)));

  // Find 2-person pods (connections)
  const twoPersonPods = await db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(isNull(podMembers.removedAt), sql`${podMembers.podId} IN (${userPodIds})`))
    .groupBy(podMembers.podId)
    .having(sql`count(*) = 2`);

  return twoPersonPods.length > 0;
}

/**
 * Require graph membership (hard DID + at least one connection)
 */
export async function requireGraphMember(request: Request): Promise<{ identity: Identity } | { error: string; status: number }> {
  const authResult = await requireAuth(request);

  if ('error' in authResult) {
    return authResult;
  }

  const { identity } = authResult;

  // Must be hard DID
  if (identity.tier === 'soft') {
    return {
      error: 'This action requires a full identity (hard DID)',
      status: 403,
    };
  }

  // Must have at least one connection
  const inGraph = await isInGraph(identity.id);
  if (!inGraph) {
    return {
      error: 'This action requires at least one connection in the trust graph',
      status: 403,
    };
  }

  return { identity };
}
