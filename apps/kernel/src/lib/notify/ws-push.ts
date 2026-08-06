/**
 * Real-time notification push over the authenticated WebSocket (#1644).
 *
 * The WS server already tracks which DIDs are connected — that is how chat
 * delivery and bump events reach a client — so a notification is the same DID
 * fan-out with a different frame type. This module is the kernel-side client for
 * that internal route; the fan-out itself lives in `apps/kernel/ws-server.js`
 * (`sendToDid`).
 *
 * Fire-and-forget by contract: a notification row is already persisted and
 * readable through `GET /notify/api/notifications`, so a failed push is a
 * degraded experience, never a failed send.
 */
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const WS_PORT = process.env.WS_PORT || process.env.PORT || '3000';
const INTERNAL_KEY = process.env.AUTH_INTERNAL_API_KEY;

/**
 * The frame a connected client receives when a notification is created.
 *
 * `type` discriminates it from the chat frames already on the socket, so an
 * always-on agent can route it without inspecting anything else. Deliberately
 * the same fields the `notifications` row carries — a client that acts on the
 * frame never has to read the row back.
 */
export interface NotificationWsFrame {
  type: 'notification';
  /** `ntf_…` — the persisted notification id, so a client can mark it read. */
  id: string;
  scope: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  /** RFC-3339, matching the stored `created_at`. */
  createdAt: string;
}

/** Build the frame for a stored notification. */
export function buildNotificationFrame(input: {
  id: string;
  scope: string;
  title: string;
  body?: string | null;
  data?: Record<string, unknown>;
  createdAt: Date | string;
}): NotificationWsFrame {
  return {
    type: 'notification',
    id: input.id,
    scope: input.scope,
    title: input.title,
    body: input.body ?? null,
    data: input.data ?? {},
    createdAt:
      input.createdAt instanceof Date ? input.createdAt.toISOString() : input.createdAt,
  };
}

/**
 * Push `frame` down every open socket for `recipientDid`.
 *
 * Returns true when at least one socket received it — i.e. the recipient was
 * actually connected. False means "nobody was listening" or "the push failed",
 * which are the same outcome for the caller: the row is still there to be read.
 *
 * Never throws.
 */
export async function pushNotificationToDid(
  recipientDid: string,
  frame: NotificationWsFrame,
): Promise<boolean> {
  if (!INTERNAL_KEY) {
    log.warn({ id: frame.id }, 'AUTH_INTERNAL_API_KEY not set, skipping notification WS push');
    return false;
  }

  try {
    const res = await fetch(`http://localhost:${WS_PORT}/chat/api/internal/did-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': INTERNAL_KEY,
      },
      body: JSON.stringify({ targetDid: recipientDid, event: frame }),
    });

    if (!res.ok) {
      log.error({ id: frame.id, status: res.status }, 'Notification WS push failed');
      return false;
    }

    const data = await res.json();
    return data.delivered ?? false;
  } catch (err) {
    log.error({ id: frame.id, err: String(err) }, 'Notification WS push error');
    return false;
  }
}
