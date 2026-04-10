/**
 * Push bump events to a DID via the internal WebSocket notify route.
 * Fire-and-forget — errors are logged but don't block the caller.
 */

const WS_PORT = process.env.WS_PORT || process.env.PORT || '3000';
const INTERNAL_KEY = process.env.AUTH_INTERNAL_API_KEY;

export type BumpWsEvent =
  | { type: 'bump:matched'; matchId: string; peer: { did: string; handle?: string; name?: string; avatar?: string }; expiresAt: string }
  | { type: 'bump:peer_confirmed'; matchId: string }
  | { type: 'bump:connected'; matchId: string; connectionId: string; peer: { did: string; handle?: string } }
  | { type: 'bump:match_expired'; matchId: string; reason: 'timeout' | 'declined' }
  | { type: 'bump:already_connected'; peer: { did: string; handle?: string; name?: string; avatar?: string }; connectedAt: string };

export async function notifyBumpDid(targetDid: string, event: BumpWsEvent): Promise<boolean> {
  if (!INTERNAL_KEY) {
    console.warn('[bump-notify] AUTH_INTERNAL_API_KEY not set, skipping WS notification');
    return false;
  }

  try {
    const res = await fetch(`http://localhost:${WS_PORT}/chat/api/internal/bump-notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': INTERNAL_KEY,
      },
      body: JSON.stringify({ targetDid, event }),
    });

    if (!res.ok) {
      console.error(`[bump-notify] failed for ${targetDid}:`, res.status);
      return false;
    }

    const data = await res.json();
    return data.delivered ?? false;
  } catch (err) {
    console.error(`[bump-notify] error for ${targetDid}:`, err);
    return false;
  }
}
