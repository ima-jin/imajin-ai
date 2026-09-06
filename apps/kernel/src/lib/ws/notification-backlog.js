/**
 * Redelivery of missed live pushes on WS reconnect (#2044).
 *
 * `pushNotificationToDid` (src/lib/notify/ws-push.ts) is WS-push-or-nothing:
 * a notification created while the recipient's socket is down is persisted
 * (`notify.notifications`) but nothing ever redelivered it — see
 * docs/warp-notification-chain.md Hop 3. This module closes that gap from
 * the connection side: immediately after a DID's socket sends
 * `{type: 'connected'}`, it asks the kernel for that DID's undelivered
 * backlog (`POST /notify/api/internal/backlog`, which claims each row
 * atomically before returning it — see src/lib/notify/backlog.ts) and
 * replays each frame straight down the socket that just connected.
 *
 * Plain CJS: ws-server.js runs outside the Next build (same reasoning as
 * also-registry.js), so this reaches the database through an internal HTTP
 * route rather than importing drizzle directly.
 */

/**
 * @param {object} options
 * @param {(did: string) => Promise<{ frames: object[], truncated: boolean }>} options.fetchBacklog
 *   Resolves the DID's already-claimed backlog frames.
 * @param {(message: string) => void} [options.log]
 */
function createNotificationBacklogReplayer(options = {}) {
  const { fetchBacklog } = options;
  const log = options.log ?? (() => {});

  /**
   * Replay `did`'s undelivered backlog down `ws`. Never throws: a failed
   * lookup means nothing was claimed, so every row is retried on the next
   * reconnect. A socket that closes partway through an already-fetched
   * batch stops sending the rest, but those rows were claimed by the fetch
   * itself (`getNotificationBacklog`'s atomic guard) and are not retried —
   * the same accepted tradeoff a live push makes for its own socket write.
   */
  async function replay(ws, did) {
    let result;
    try {
      result = await fetchBacklog(did);
    } catch (err) {
      log(`notification backlog fetch failed for ${did}: ${err.message}`);
      return;
    }

    const frames = result && Array.isArray(result.frames) ? result.frames : [];
    for (const frame of frames) {
      if (ws.readyState !== 1) break; // WebSocket.OPEN — socket closed mid-replay
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        log(`notification backlog send failed for ${did}: ${err.message}`);
        break;
      }
    }

    if (result && result.truncated) {
      log(`notification backlog truncated for ${did}`);
    }
  }

  return { replay };
}

module.exports = { createNotificationBacklogReplayer };
