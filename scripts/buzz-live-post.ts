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

import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

// ── Minimal NIP-01 types ──────────────────────────────────────────────────────

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

function computeEventId(
  pubkey: string,
  created_at: number,
  kind: number,
  tags: string[][],
  content: string,
): string {
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

function buildKind9Event(
  pubkey: string,
  groupId: string,
  content: string,
  privkeyHex: string,
  ownerDid?: string,
  attestationDigest?: string,
): NostrEvent {
  const created_at = Math.floor(Date.now() / 1000);
  const tags: string[][] = [['h', groupId]];
  if (ownerDid) tags.push(['imajin-did', ownerDid]);
  if (attestationDigest) tags.push(['imajin-attestation', attestationDigest]);

  const id = computeEventId(pubkey, created_at, 9, tags, content);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), privkeyHex));
  return { id, pubkey, created_at, kind: 9, tags, content, sig };
}

function buildAuthEvent(
  pubkey: string,
  relayUrl: string,
  challenge: string,
  privkeyHex: string,
): NostrEvent {
  const created_at = Math.floor(Date.now() / 1000);
  const tags = [['relay', relayUrl], ['challenge', challenge]];
  const id = computeEventId(pubkey, created_at, 22242, tags, '');
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), privkeyHex));
  return { id, pubkey, created_at, kind: 22242, tags, content: '', sig };
}

// ── Relay transport ───────────────────────────────────────────────────────────

const TIMEOUT_MS = 15_000;

function sendToRelay(
  relayUrl: string,
  event: NostrEvent,
  pubkeyHex: string,
  privkeyHex: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const done = (err?: Error): void => {
      clearTimeout(timer);
      ws.terminate();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => done(new Error(`buzz: relay ${relayUrl} timed out after ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );

    let eventSent = false;
    let awaitingAuthChallenge = false;

    const sendEvent = (): void => {
      if (eventSent) return;
      eventSent = true;
      ws.send(JSON.stringify(['EVENT', event]));
    };

    ws.on('open', () => { sendEvent(); });

    ws.on('message', (raw: Buffer) => {
      let msg: unknown;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!Array.isArray(msg) || msg.length === 0) return;
      const [type] = msg;

      if (type === 'AUTH' && typeof msg[1] === 'string') {
        awaitingAuthChallenge = false;
        ws.send(JSON.stringify(['AUTH', buildAuthEvent(pubkeyHex, relayUrl, msg[1], privkeyHex)]));
        eventSent = false;
        sendEvent();
        return;
      }

      if (type === 'OK' && msg[1] === event.id) {
        if (msg[2] === true) { done(); return; }
        const reason = typeof msg[3] === 'string' ? msg[3] : 'rejected';
        if (reason.startsWith('auth-required') && !awaitingAuthChallenge) {
          awaitingAuthChallenge = true;
          eventSent = false;
          return;
        }
        done(new Error(`buzz: relay rejected event (${reason})`));
        return;
      }

      if (type === 'NOTICE' && typeof msg[1] === 'string') {
        process.stderr.write(`[relay NOTICE] ${msg[1]}\n`);
      }
    });

    ws.on('error', (err: Error) => {
      done(new Error(`buzz: WebSocket error — ${err.message}`));
    });
  });
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

const pubkeyHex = bytesToHex(schnorr.getPublicKey(privkeyHex));

process.stderr.write(`[buzz-live-post] pubkey : ${pubkeyHex}\n`);
process.stderr.write(`[buzz-live-post] relay  : ${relayUrl}\n`);
process.stderr.write(`[buzz-live-post] group  : ${groupId}\n`);
if (ownerDid)  process.stderr.write(`[buzz-live-post] did    : ${ownerDid}\n`);
if (attDigest) process.stderr.write(`[buzz-live-post] digest : ${attDigest}\n`);

const event = buildKind9Event(pubkeyHex, groupId, message, privkeyHex, ownerDid, attDigest);

process.stderr.write(`[buzz-live-post] event_id: ${event.id}\n`);
process.stderr.write(`[buzz-live-post] sending…\n`);

await sendToRelay(relayUrl, event, pubkeyHex, privkeyHex);

// Output the full event as JSON so it can be piped to demo-log.json
process.stdout.write(JSON.stringify({ ok: true, event }, null, 2) + '\n');
process.stderr.write('[buzz-live-post] ✓ relay confirmed\n');
