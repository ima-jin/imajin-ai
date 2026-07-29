/**
 * NIP-01 Nostr event building and signing.
 *
 * Implements the minimal Nostr event model needed for:
 *   - NIP-42: relay authentication (kind:22242)
 *   - NIP-29: simple group messages (kind:9 with required `#h` tag)
 *
 * All functions are pure (no I/O) so they can be tested in isolation.
 *
 * Signing uses secp256k1 Schnorr / BIP-340 via @noble/curves:
 *   event.id  = SHA-256( JSON([0, pubkey, created_at, kind, tags, content]) )
 *   event.sig = schnorr.sign(id_bytes_32, privkeyHex)
 */

import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@imajin/auth';

/** SHA-256 via node:crypto — server-side only, no @noble/hashes dep conflict. */
function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A fully signed NIP-01 Nostr event. */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A Nostr event before id/sig are computed. */
export type UnsignedNostrEvent = Omit<NostrEvent, 'id' | 'sig'>;

// ── Key helpers ───────────────────────────────────────────────────────────────

/**
 * Derive the x-only secp256k1 public key (hex, 32 bytes / 64 chars)
 * from a private key hex string.
 */
export function deriveNostrPubkey(privkeyHex: string): string {
  return bytesToHex(schnorr.getPublicKey(privkeyHex));
}

/**
 * Generate a new random secp256k1 private key (hex, 32 bytes / 64 chars).
 * Suitable for sealing immediately — never store or log the raw output.
 */
export function generateNostrPrivkey(): string {
  return bytesToHex(schnorr.utils.randomPrivateKey());
}

// ── Event building ────────────────────────────────────────────────────────────

/**
 * Serialize an unsigned Nostr event for NIP-01 ID computation.
 * Output: JSON array [0, pubkey, created_at, kind, tags, content]
 */
function serializeForId(event: UnsignedNostrEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/**
 * Compute the NIP-01 event ID: SHA-256 of the serialized event bytes, as hex.
 */
export function computeEventId(event: UnsignedNostrEvent): string {
  const bytes = sha256(new TextEncoder().encode(serializeForId(event)));
  return bytesToHex(bytes);
}

/**
 * Sign an unsigned Nostr event with a secp256k1 private key.
 * Returns a complete NIP-01 event with `id` and `sig` set.
 */
export function signNostrEvent(
  event: UnsignedNostrEvent,
  privkeyHex: string,
): NostrEvent {
  const id = computeEventId(event);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), privkeyHex));
  return { ...event, id, sig };
}

// ── NIP-42: relay authentication ──────────────────────────────────────────────

/**
 * Build and sign a NIP-42 auth event (kind:22242).
 *
 * Proves to the relay that the client controls the private key corresponding
 * to `pubkey`. The relay will compare the challenge tag against the string it
 * sent in the `["AUTH", challenge]` message.
 *
 * Tags: [["relay", relayUrl], ["challenge", challenge]]
 */
export function buildAuthEvent(
  pubkey: string,
  relayUrl: string,
  challenge: string,
  privkeyHex: string,
): NostrEvent {
  const unsigned: UnsignedNostrEvent = {
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 22242,
    tags: [
      ['relay', relayUrl],
      ['challenge', challenge],
    ],
    content: '',
  };
  return signNostrEvent(unsigned, privkeyHex);
}

// ── NIP-29: group messages ────────────────────────────────────────────────────

/**
 * Build and sign a NIP-29 kind:9 group message.
 *
 * The `#h` tag identifies the target group on a NIP-29 relay.
 * NIP-29 relays enforce group membership; the relay will reject the event
 * if the signing pubkey is not an admitted group member.
 */
export function buildKind9Event(
  pubkey: string,
  groupId: string,
  content: string,
  privkeyHex: string,
): NostrEvent {
  const unsigned: UnsignedNostrEvent = {
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [['h', groupId]],
    content,
  };
  return signNostrEvent(unsigned, privkeyHex);
}
