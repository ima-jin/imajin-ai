#!/usr/bin/env tsx
/**
 * buzz-live-post.ts — Live Buzz relay demo post (#1414)
 *
 * Posts a signed, DID-tagged NIP-29 kind:9 message to a running Buzz relay.
 * No kernel or vault required — runs standalone via npx tsx.
 *
 * Required env vars:
 *   BUZZ_NOSTR_PRIVKEY       secp256k1 private key hex (64 chars / 32 bytes)
 *   BUZZ_RELAY_URL           WebSocket URL, e.g. ws://localhost:3000
 *   BUZZ_GROUP_ID            NIP-29 group ID (value of the #h tag)
 *
 * Optional env vars:
 *   BUZZ_MESSAGE             Message content (default: "Hello from Jin 🐝")
 *   BUZZ_OWNER_DID           Imajin DID for the [imajin-did] tag
 *   BUZZ_ATTESTATION_DIGEST  64-char hex digest for the [imajin-attestation] tag
 *
 * Output: JSON with the sent event on stdout; errors on stderr.
 *
 * Usage (from repo root):
 *   BUZZ_NOSTR_PRIVKEY=<hex> \
 *   BUZZ_RELAY_URL=ws://localhost:3000 \
 *   BUZZ_GROUP_ID=imajin-demo \
 *   BUZZ_OWNER_DID=did:imajin:ryan \
 *   BUZZ_ATTESTATION_DIGEST=<digest_hex> \
 *     npx tsx scripts/buzz-live-post.ts | tee demo-log.json
 */

import {
  signNostrEvent,
  deriveNostrPubkey,
  type NostrEvent,
  type UnsignedNostrEvent,
} from '../apps/kernel/src/lib/buzz/nostr-event';
import { sendToRelay } from '../apps/kernel/src/lib/buzz/relay-transport';

// ── DID-tagged kind:9 builder ───────────────────────────────────────────────────

/**
 * Build a NIP-29 kind:9 event with optional Imajin DID attribution tags.
 * This script-local variant adds [imajin-did] + [imajin-attestation] on top
 * of the standard #h tag; the shared buildKind9Event in nostr-event.ts does
 * not have these params on the main branch (they land via #1413).
 */
function buildKind9WithDidTags(
  pubkey: string,
  groupId: string,
  content: string,
  privkeyHex: string,
  ownerDid?: string,
  attestationDigest?: string,
): NostrEvent {
  const tags: string[][] = [['h', groupId]];
  if (ownerDid) tags.push(['imajin-did', ownerDid]);
  if (attestationDigest) tags.push(['imajin-attestation', attestationDigest]);
  const unsigned: UnsignedNostrEvent = {
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags,
    content,
  };
  return signNostrEvent(unsigned, privkeyHex);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const privkeyHex = process.env.BUZZ_NOSTR_PRIVKEY;
const relayUrl   = process.env.BUZZ_RELAY_URL;
const groupId    = process.env.BUZZ_GROUP_ID;
const message    = process.env.BUZZ_MESSAGE ?? 'Hello from Jin 🐝 — first DID-tagged Imajin agent message (#1414)';
const ownerDid   = process.env.BUZZ_OWNER_DID;
const attDigest  = process.env.BUZZ_ATTESTATION_DIGEST;

if (!privkeyHex || !relayUrl || !groupId) {
  process.stderr.write(
    'Usage: BUZZ_NOSTR_PRIVKEY=<hex> BUZZ_RELAY_URL=<ws://...> BUZZ_GROUP_ID=<id>' +
    ' [BUZZ_MESSAGE=...] [BUZZ_OWNER_DID=...] [BUZZ_ATTESTATION_DIGEST=...]' +
    ' npx tsx scripts/buzz-live-post.ts\n',
  );
  process.exit(1);
}

const pubkeyHex = deriveNostrPubkey(privkeyHex);

process.stderr.write(`[buzz-live-post] pubkey : ${pubkeyHex}\n`);
process.stderr.write(`[buzz-live-post] relay  : ${relayUrl}\n`);
process.stderr.write(`[buzz-live-post] group  : ${groupId}\n`);
if (ownerDid)  process.stderr.write(`[buzz-live-post] did    : ${ownerDid}\n`);
if (attDigest) process.stderr.write(`[buzz-live-post] digest : ${attDigest}\n`);

const event = buildKind9WithDidTags(pubkeyHex, groupId, message, privkeyHex, ownerDid, attDigest);

process.stderr.write(`[buzz-live-post] event_id: ${event.id}\n`);
process.stderr.write(`[buzz-live-post] sending…\n`);

await sendToRelay(relayUrl, event, pubkeyHex, privkeyHex, (n) => process.stderr.write(`[relay NOTICE] ${n}\n`), 15_000);

// Output the full event as JSON so it can be piped to demo-log.json
process.stdout.write(JSON.stringify({ ok: true, event }, null, 2) + '\n');
process.stderr.write('[buzz-live-post] ✓ relay confirmed\n');
