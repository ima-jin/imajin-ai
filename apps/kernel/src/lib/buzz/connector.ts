/**
 * Buzz/Nostr connector backend library (#1412).
 *
 * Manages a vault-sealed secp256k1 Nostr keypair per DID and provides the
 * full message-send pipeline over a Nostr relay WebSocket:
 *
 *   generateAndSeal  — generate a new keypair; seal private key into the vault
 *   getPublicKey     — derive the public key from the sealed private key
 *   sendKind9        — NIP-42 auth + NIP-29 kind:9 send, confirmed by relay OK
 *
 * Security invariants (mirrors the Discord/GitHub connector pattern):
 *   - Vault field is per-DID: `nostr-key:${ownerDid}` — cross-DID reads impossible.
 *   - Private key is never logged, returned to callers, or exposed beyond this module.
 *   - Private key is held in memory only for the duration of the call that needs it.
 *   - Fail-closed: no sealed key → throw `buzz_no_key`; relay rejection → throw.
 */

import { createLogger } from '@imajin/logger';
import { sealAndStore, loadAndUnseal } from '@/src/lib/vault';
import {
  generateNostrPrivkey,
  deriveNostrPubkey,
  buildKind9Event,
} from './nostr-event';
import { sendToRelay } from './relay-transport';
import { loadDidTags } from './did-resolver';

const log = createLogger('kernel');

// ── Vault helpers ─────────────────────────────────────────────────────────────

/**
 * Per-DID vault field name for the Nostr private key.
 * Encoding ownerDid in the field name enforces per-DID isolation:
 * different DIDs cannot share or cross-read each other's keys.
 */
export function vaultField(ownerDid: string): string {
  return `nostr-key:${ownerDid}`;
}

// ── Key management ────────────────────────────────────────────────────────────

/**
 * Generate a new secp256k1 keypair and seal the private key for ownerDid.
 *
 * The private key is generated in memory and immediately sealed via AES-256-GCM
 * into the vault. It is NEVER returned, logged, or exposed beyond the seal call.
 *
 * Returns only the derived hex public key. Re-run to rotate the key — the
 * previous sealed entry is superseded by the new one.
 */
export async function generateAndSeal(ownerDid: string): Promise<{ pubkeyHex: string }> {
  const privkeyHex = generateNostrPrivkey();
  const pubkeyHex = deriveNostrPubkey(privkeyHex);
  await sealAndStore(vaultField(ownerDid), privkeyHex);
  // Private key leaves scope here — only pubkeyHex is returned.
  return { pubkeyHex };
}

/**
 * Derive the hex public key for ownerDid from their sealed private key.
 *
 * Returns undefined if no key has been sealed yet (buzz_connect not run).
 * The private key is unseal-then-discard; it is never stored in a variable
 * that outlives this function.
 */
export async function getPublicKey(ownerDid: string): Promise<string | undefined> {
  const privkeyHex = await loadAndUnseal(vaultField(ownerDid));
  if (privkeyHex === undefined) return undefined;
  return deriveNostrPubkey(privkeyHex);
}

// ── Message send ──────────────────────────────────────────────────────────────

/**
 * Send a NIP-29 kind:9 group message to a Buzz relay on behalf of ownerDid.
 *
 * Full pipeline:
 *   1. Unseal the Nostr private key from the vault (held in memory only).
 *   2. Build a signed kind:9 event (pubkey + `#h` group tag + content).
 *   3. Open a WebSocket to `relayUrl`.
 *   4. Handle NIP-42 auth challenge if the relay sends one:
 *        relay → ["AUTH", challenge]
 *        client → ["AUTH", signed kind:22242 event]
 *   5. Send ["EVENT", kind9Event].
 *   6. Wait for ["OK", eventId, true, ""] and close.
 *
 * The private key is cleared from local scope as soon as the event is built.
 * It is never logged or returned.
 *
 * Returns the relay-confirmed event ID.
 *
 * Throws:
 *   - `buzz_no_key`   — no sealed key for ownerDid (run buzz_connect first)
 *   - relay error     — relay rejected the event or connection failed
 *   - timeout         — relay did not respond within RELAY_TIMEOUT_MS
 */
export async function sendKind9(
  ownerDid: string,
  relayUrl: string,
  groupId: string,
  content: string,
): Promise<{ eventId: string }> {
  const privkeyHex = await loadAndUnseal(vaultField(ownerDid));
  if (privkeyHex === undefined) {
    throw new Error(
      `buzz_no_key: no Nostr key sealed for DID ${ownerDid} — run buzz_connect first`,
    );
  }

  const pubkeyHex = deriveNostrPubkey(privkeyHex);
  // Load DID attribution tags (#1413) — non-fatal if no binding exists yet.
  const didTags = await loadDidTags(ownerDid);
  const event = buildKind9Event(pubkeyHex, groupId, content, privkeyHex, didTags);
  // Private key is no longer needed after signing — let it fall out of scope.

  await sendToRelay(
    relayUrl,
    event,
    pubkeyHex,
    privkeyHex,
    (notice) => log.info({ relay: relayUrl, notice }, 'Nostr relay NOTICE'),
  );
  return { eventId: event.id };
}

