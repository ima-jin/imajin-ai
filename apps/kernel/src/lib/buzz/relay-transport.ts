/**
 * Nostr relay WebSocket transport (#1414).
 *
 * Extracted from connector.ts so that both the vault-backed connector and the
 * standalone scripts/buzz-live-post.ts demo script can share the same
 * NIP-01/NIP-42 send pipeline without duplicating ~100 lines of WebSocket code.
 *
 * sendToRelay:
 *   Open a WebSocket to `relayUrl`, perform NIP-42 auth if challenged,
 *   send `event`, and wait for an ["OK", eventId, true, ...] confirmation.
 *
 * NIP-42 auth can arrive in two ways:
 *   (a) Immediately after connect — relay sends AUTH before we send EVENT.
 *   (b) After EVENT — relay replies with OK false "auth-required:...".
 *
 * Both are handled:
 *   - On any AUTH message: sign and respond, then (re)send EVENT.
 *   - On OK false "auth-required": wait for AUTH, respond, resend EVENT.
 *   - On OK true: resolve.
 *   - On OK false (other reason): reject.
 */

import WebSocket from 'ws';
import { buildAuthEvent } from './nostr-event';
import type { NostrEvent } from './nostr-event';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Open a WebSocket to `relayUrl`, handle NIP-42 auth if challenged, send
 * `event`, and wait for relay confirmation.
 *
 * @param onNotice  Optional callback for relay NOTICE messages. Silently
 *                  ignored when omitted — callers may pass `console.error` or
 *                  a structured logger as appropriate.
 */
export function sendToRelay(
  relayUrl: string,
  event: NostrEvent,
  pubkeyHex: string,
  privkeyHex: string,
  onNotice?: (notice: string) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);

    /** Resolve or reject and close the socket cleanly. */
    const done = (err?: Error): void => {
      clearTimeout(timer);
      ws.terminate();
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      done(new Error(`buzz: relay ${relayUrl} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    /** True once we have successfully sent the EVENT frame. */
    let eventSent = false;
    /**
     * True when the relay replied auth-required but we haven't
     * received the AUTH challenge yet — hold off on resending.
     */
    let awaitingAuthChallenge = false;

    const sendEvent = (): void => {
      if (eventSent) return;
      eventSent = true;
      ws.send(JSON.stringify(['EVENT', event]));
    };

    ws.on('open', () => {
      // Optimistically send the event immediately. If the relay requires auth
      // it will either send AUTH before ACKing or reply OK false auth-required.
      sendEvent();
    });

    ws.on('message', (rawData: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(rawData.toString('utf8'));
      } catch {
        return;
      }
      if (!Array.isArray(msg) || msg.length === 0) return;

      const [type] = msg;

      // ── NIP-42 challenge ────────────────────────────────────────────────────
      if (type === 'AUTH' && typeof msg[1] === 'string') {
        awaitingAuthChallenge = false;
        const authEvent = buildAuthEvent(pubkeyHex, relayUrl, msg[1], privkeyHex);
        ws.send(JSON.stringify(['AUTH', authEvent]));
        // (Re)send the EVENT under the now-authenticated session.
        eventSent = false;
        sendEvent();
        return;
      }

      // ── EVENT acknowledgement ───────────────────────────────────────────────
      if (type === 'OK' && msg[1] === event.id) {
        const accepted = msg[2] === true;

        if (accepted) {
          done();
          return;
        }

        const reason = typeof msg[3] === 'string' ? msg[3] : 'rejected';

        // Relay needs auth but hasn't sent the challenge yet — wait for AUTH.
        if (reason.startsWith('auth-required') && !awaitingAuthChallenge) {
          awaitingAuthChallenge = true;
          eventSent = false;
          return;
        }

        done(new Error(`buzz: relay rejected event (${reason})`));
        return;
      }

      // ── Relay notices (informational) ───────────────────────────────────────
      if (type === 'NOTICE' && typeof msg[1] === 'string') {
        onNotice?.(msg[1]);
      }
    });

    ws.on('error', (err: Error) => {
      done(new Error(`buzz: relay WebSocket error — ${err.message}`));
    });
  });
}
