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
 *
 * ## Redelivery (#2044) and ack-confirmed delivery (#2099)
 * A push that finds nobody connected used to be a dead end beyond the
 * persisted row — see `docs/warp-notification-chain.md` Hop 3. `ws-server.js`
 * now replays a recipient's undelivered backlog immediately on reconnect
 * (`src/lib/notify/backlog.ts`), so this function claims the row
 * (`delivery.ts`'s atomic WS-send-attempt guard) before attempting the push,
 * and rolls the claim back if the push does not actually reach a socket —
 * the same guard the backlog replay uses, so the two paths can never both
 * attempt the same notification at once.
 *
 * A WS `.send()` succeeding here does NOT mark the row delivered: a socket
 * whose peer already crashed still reports `readyState === OPEN`, which is
 * exactly the stale-socket gap #2099 closes. `delivered_at` is set only by
 * an explicit `{ type: 'notification_ack' }` frame from the recipient's
 * plugin (`ackNotificationDelivery`, handled by `ws-server.js`).
 */
import { createLogger } from '@imajin/logger';
import { claimNotificationForWsSend, rollbackWsClaim, WS_MAX_ATTEMPTS } from './delivery';

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
  /** Set on a backlog-replayed frame (#2044) — absent on a live push. */
  replay?: true;
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
 *
 * ## Observability (2026-09-05 incident)
 * The "nobody was listening" branch (`res.ok` but `delivered: false`) used to
 * be entirely silent — no log line at all, unlike the error branches below —
 * so a run that completed while the owner's socket happened to be briefly
 * disconnected left no trace of *why* the live push never reached them
 * (the notification row itself is unaffected; only the WS leg is silent).
 * That branch now gets a `warn`, and `GET /notify/api/health` surfaces a
 * rolling count of `inapp`-eligible notifications that missed their WS leg
 * (`recentWsPushMisses`, backed by `channelsSent` on the `notifications`
 * row already written in `/notify/api/send`) so a miss is visible on an
 * existing health surface without grepping logs across instances.
 */

/**
 * Roll back `id`'s WS-send claim, swallowing any error. This already runs
 * from inside `pushNotificationToDid`'s "never throws" contract; a failed
 * rollback just leaves the row claimed until its ack timeout elapses,
 * degrading to "replayed later than ideal" rather than throwing out of a
 * fire-and-forget push.
 */
async function rollbackClaimSafely(id: string): Promise<void> {
  try {
    await rollbackWsClaim(id);
  } catch (err) {
    log.error({ id, err: String(err) }, 'Notification WS claim rollback failed');
  }
}

/** Warn once a row has spent its last permitted WS re-offer (#2099). */
function warnIfAttemptsCapped(id: string, attempts: number): void {
  if (attempts < WS_MAX_ATTEMPTS) return;
  log.warn({ id, attempts }, 'Notification WS re-offer cap reached');
}

export async function pushNotificationToDid(
  recipientDid: string,
  frame: NotificationWsFrame,
): Promise<boolean> {
  if (!INTERNAL_KEY) {
    log.warn({ id: frame.id }, 'AUTH_INTERNAL_API_KEY not set, skipping notification WS push');
    return false;
  }

  // Claim this row before attempting delivery (#2044/#2099): the same atomic
  // guard a backlog replay uses (delivery.ts), so a notification created at
  // the exact instant its recipient reconnects is never attempted by both
  // paths at once.
  let claim = { claimed: true, attempts: 0 };
  try {
    claim = await claimNotificationForWsSend(frame.id);
  } catch (err) {
    log.error({ id: frame.id, err: String(err) }, 'Notification WS claim failed');
    // Fail open: a DB hiccup here must not silently drop a live push. Worst
    // case is a rare duplicate frame, not a permanently missed one.
    claim = { claimed: true, attempts: 0 };
  }
  if (!claim.claimed) {
    return false;
  }
  warnIfAttemptsCapped(frame.id, claim.attempts);

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
      await rollbackClaimSafely(frame.id);
      return false;
    }

    const data = await res.json();
    const delivered: boolean = data.delivered ?? false;
    if (!delivered) {
      log.warn(
        { id: frame.id, recipientDid },
        'Notification WS push found no connected socket for recipient',
      );
      await rollbackClaimSafely(frame.id);
    }
    return delivered;
  } catch (err) {
    log.error({ id: frame.id, err: String(err) }, 'Notification WS push error');
    await rollbackClaimSafely(frame.id);
    return false;
  }
}
