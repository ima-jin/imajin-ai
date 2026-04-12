import { getSession } from './session';
import { getClient } from '@imajin/db';

const sql = getClient();

/**
 * Shared requireAdmin helper — extracted from the copy-pasted pattern
 * in apps/kernel/app/api/admin/**\/route.ts.
 *
 * Verifies the active session's actingAs DID is a node-scope group identity.
 * Returns the session if the caller is an admin, null otherwise.
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

  const [nodeRow] = await sql`
    SELECT id FROM auth.identities
    WHERE id = ${session.actingAs}
    AND scope = 'actor' AND subtype = 'node'
    LIMIT 1
  `;

  return nodeRow ? session : null;
}
