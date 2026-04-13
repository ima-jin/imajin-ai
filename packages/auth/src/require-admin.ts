import { getSession } from './session';
import { getClient } from '@imajin/db';

const sql = getClient();

/**
 * Shared requireAdmin helper — extracted from the copy-pasted pattern
 * in apps/kernel/app/api/admin/**\/route.ts.
 *
 * Verifies the active session's actingAs DID matches the node DID (NODE_DID env var).
 * Returns the session if the caller is an admin, null otherwise.
 *
 * Future: scoped admin views where any non-actor identity gets filtered access
 * based on its scope (community sees its own newsletter/telemetry, etc.).
 *
 * Usage:
 *   import { requireAdmin } from '@imajin/auth';
 *
 *   export async function GET() {
 *     const session = await requireAdmin();
 *     if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 *     // ...
 *   }
 */
export async function requireAdmin() {
  const session = await getSession();
  if (!session?.actingAs) return null;

  const nodeDid = process.env.NODE_DID;
  if (!nodeDid) return null;

  return session.actingAs === nodeDid ? session : null;
}
