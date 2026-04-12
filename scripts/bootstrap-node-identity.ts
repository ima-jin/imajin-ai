#!/usr/bin/env tsx
/**
 * Node identity bootstrap (#675)
 *
 * Generates an Ed25519 keypair, creates a did:imajin DID for this node,
 * inserts the node identity into the DB, and wires it into relay.relay_config.
 *
 * Usage:
 *   cd apps/kernel
 *   npx tsx ../../scripts/bootstrap-node-identity.ts
 *
 * Idempotent: if relay_config.imajin_did is already set, exits with the existing DID.
 *
 * Env vars:
 *   NODE_NAME          — display name for the node (default: 'Imajin Node')
 *   NODE_OPERATOR_DID  — DID of the operator to grant owner role
 *   DATABASE_URL       — required
 *   MFA_ENCRYPTION_KEY — optional; falls back to dev key for private key encryption
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import postgres from 'postgres';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { createHash, randomBytes, createCipheriv } from 'crypto';

// Configure ed25519 to use sha512 (required by @noble/ed25519 v2+)
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ---------------------------------------------------------------------------
// Load .env.local (same pattern as backfill-emissions.ts)
// ---------------------------------------------------------------------------
try {
  const envPath = resolve(process.cwd(), '.env.local');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // No .env.local — rely on environment
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set. Run from apps/kernel/ directory.');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

// ---------------------------------------------------------------------------
// Crypto helpers (inlined to avoid path alias issues in script context)
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function didFromPublicKey(publicKeyBytes: Uint8Array): string {
  const encoded = bs58.encode(publicKeyBytes);
  return `did:imajin:${encoded}`;
}

function encryptSecret(plaintext: string): string {
  const keyHex = process.env.MFA_ENCRYPTION_KEY;
  const key = keyHex
    ? Buffer.from(keyHex, 'hex')
    : createHash('sha256').update('dev-mfa-encryption-key-imajin').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\nNode Identity Bootstrap (#675)\n');

  // Check idempotency — if imajin_did already set, skip
  const [existing] = await sql`
    SELECT imajin_did FROM relay.relay_config WHERE id = 'singleton' LIMIT 1
  `;

  if (existing?.imajin_did) {
    console.log('Node identity already bootstrapped.');
    console.log('  Node DID:', existing.imajin_did);
    await sql.end();
    return;
  }

  const nodeName = process.env.NODE_NAME || 'Imajin Node';
  const operatorDid = process.env.NODE_OPERATOR_DID || null;

  // 1. Generate Ed25519 keypair
  const privateKeyBytes = ed.utils.randomPrivateKey();
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);
  const privateKeyHex = bytesToHex(privateKeyBytes);
  const publicKeyHex = bytesToHex(publicKeyBytes);
  const nodeDid = didFromPublicKey(publicKeyBytes);

  console.log('Generated node DID:', nodeDid);

  // 2. Insert into auth.identities (scope='actor', subtype='node', tier='established')
  await sql`
    INSERT INTO auth.identities (id, scope, subtype, public_key, name, tier, created_at, updated_at)
    VALUES (
      ${nodeDid},
      'actor',
      'node',
      ${publicKeyHex},
      ${nodeName},
      'established',
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  console.log('  Inserted auth.identities');

  // 3. Store encrypted private key in auth.stored_keys
  const encryptedKey = encryptSecret(privateKeyHex);
  await sql`
    INSERT INTO auth.stored_keys (id, did, encrypted_key, salt, key_derivation, created_at)
    VALUES (
      ${genId('key')},
      ${nodeDid},
      ${encryptedKey},
      'server-side',
      'aes-256-gcm',
      NOW()
    )
    ON CONFLICT (did) DO NOTHING
  `;
  console.log('  Stored encrypted private key in auth.stored_keys');

  // 4. Update relay.relay_config with imajin_did (and optionally node_operator_did)
  if (operatorDid) {
    await sql`
      UPDATE relay.relay_config
      SET imajin_did = ${nodeDid}, node_operator_did = ${operatorDid}
      WHERE id = 'singleton'
    `;
    console.log('  Updated relay.relay_config (imajin_did + node_operator_did)');
  } else {
    await sql`
      UPDATE relay.relay_config
      SET imajin_did = ${nodeDid}
      WHERE id = 'singleton'
    `;
    console.log('  Updated relay.relay_config (imajin_did)');
  }

  // 5. Insert into auth.group_identities (scope='node')
  await sql`
    INSERT INTO auth.group_identities (group_did, scope, created_by, created_at)
    VALUES (${nodeDid}, 'node', ${nodeDid}, NOW())
    ON CONFLICT (group_did) DO NOTHING
  `;
  console.log('  Inserted auth.group_identities');

  // 6. If NODE_OPERATOR_DID set, insert into auth.group_controllers
  if (operatorDid) {
    await sql`
      INSERT INTO auth.group_controllers (group_did, controller_did, role, added_at)
      VALUES (${nodeDid}, ${operatorDid}, 'owner', NOW())
      ON CONFLICT DO NOTHING
    `;
    console.log('  Inserted auth.group_controllers (operator as owner)');
  }

  // 7. Insert into profile.profiles
  await sql`
    INSERT INTO profile.profiles (did, display_name, display_type, handle, created_at, updated_at)
    VALUES (${nodeDid}, ${nodeName}, 'human', NULL, NOW(), NOW())
    ON CONFLICT (did) DO NOTHING
  `;
  console.log('  Inserted profile.profiles');

  console.log('\nDone. Node DID:', nodeDid);
  if (operatorDid) {
    console.log('Operator DID:', operatorDid);
  }

  await sql.end();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
