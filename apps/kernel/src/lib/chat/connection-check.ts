/**
 * Shared connection / consent checks (#855).
 *
 * `isConnected` used to live in app/profile/lib/profile-data.ts, which made it
 * unreachable from the chat routes without dragging profile-page concerns into
 * them. It lives here now; the profile module re-exports it so existing callers
 * keep working.
 */
import { eq } from 'drizzle-orm';
import { db, identities } from '@/src/db';

/** Error surfaced when a DM is attempted without an active connection. */
export const DM_CONNECTION_REQUIRED = 'You must be connected to message this person';

/**
 * True when `viewerDid` and `targetDid` share an active (not disconnected)
 * connection. The pair is stored sorted, so sort before querying.
 */
export async function isConnected(viewerDid: string, targetDid: string): Promise<boolean> {
  try {
    const [connDidA, connDidB] = [viewerDid, targetDid].sort((a, b) => a.localeCompare(b));
    const row = await db.query.connections.findFirst({
      where: (c, { eq: eqOp, and, isNull }) => and(
        eqOp(c.didA, connDidA),
        eqOp(c.didB, connDidB),
        isNull(c.disconnectedAt)
      ),
    });
    return !!row;
  } catch { return false; }
}

/**
 * True when `did` is registered as an agent identity. Agents are service
 * endpoints — they are always reachable, no connection required.
 */
export async function isAgentDid(did: string): Promise<boolean> {
  try {
    const identity = await db.query.identities.findFirst({ where: eq(identities.id, did) });
    return identity?.subtype === 'agent';
  } catch { return false; }
}

/**
 * Consent gate for opening a NEW direct-message thread with `targetDid`.
 *
 * Allowed when the sender messages themselves (notes-to-self), when the pair
 * has an active connection, or when the target is an agent. Everything else is
 * refused — an existing thread is the caller's job to detect and skip.
 */
export async function canInitiateDm(senderDid: string, targetDid: string): Promise<boolean> {
  if (senderDid === targetDid) return true;
  if (await isConnected(senderDid, targetDid)) return true;
  return isAgentDid(targetDid);
}
