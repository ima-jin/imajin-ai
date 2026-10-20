import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from '@noble/curves/ed25519';
import { crypto as authCrypto } from '@imajin/auth';
import { extractPrivateKeySeed } from '@imajin/vault-core';
import { getNodeSigningIdentity } from './sealing';
import { resolveVaultPath } from './vault-path';
import { isAppSelfSecretField, isGroupKeyField, isImportedKeyField, parseVaultFieldName } from './field-grammar';

type Field = { field: string; plaintext: string };
type Envelope = {
  version: 1;
  oldPublicKey: string;
  newPublicKey: string;
  exported: number;
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  signature: string;
};
const DOMAIN = 'imajin-node-rotation-handoff-v1';
const MAX_BYTES = 16 * 1024 * 1024;
const HEX_KEY = /^[0-9a-f]{64}$/;

/** Private custody rails must never be migrated through the ordinary sweep. */
export function isSweepField(field: unknown): field is string {
  return typeof field === 'string' && parseVaultFieldName(field).ok &&
    !isAppSelfSecretField(field) && !isGroupKeyField(field) && !isImportedKeyField(field);
}

function metadata(e: Omit<Envelope, 'signature'>, context: string): Buffer {
  return Buffer.from(JSON.stringify([DOMAIN, context, e.version, e.oldPublicKey,
    e.newPublicKey, e.exported, e.ephemeralPublicKey, e.nonce]));
}

function signingMessage(e: Omit<Envelope, 'signature'>, context: string): string {
  return JSON.stringify([metadata(e, context).toString('base64'), e.ciphertext, e.tag]);
}

function encryptionKey(shared: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, DOMAIN, 'handoff-encryption', 32));
}

export function validateRotationRecipient(publicKey: unknown): asserts publicKey is string {
  if (typeof publicKey !== 'string' || !HEX_KEY.test(publicKey)) throw new Error('Invalid rotation recipient');
  // Reject noncanonical, small-order and non-torsion-free Ed25519 points.
  const point = ed25519.ExtendedPoint.fromHex(publicKey);
  if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error('Invalid rotation recipient');
}

/** New-key-only encryption, with an old-key signature authenticating the source. */
export function sealRotationHandoff(fields: Field[], newPublicKey: string, privateKey: string, context: string): Envelope {
  validateRotationRecipient(newPublicKey);
  const seed = extractPrivateKeySeed(privateKey);
  const oldPublicKey = authCrypto.getPublicKey(seed);
  if (oldPublicKey === newPublicKey) throw new Error('Rotation requires a different key');
  const ephemeral = randomBytes(32);
  const nonce = randomBytes(12);
  const header = {
    version: 1 as const, oldPublicKey, newPublicKey, exported: fields.length,
    ephemeralPublicKey: Buffer.from(x25519.getPublicKey(ephemeral)).toString('hex'),
    nonce: nonce.toString('hex'), ciphertext: '', tag: '',
  };
  const key = encryptionKey(x25519.getSharedSecret(ephemeral, edwardsToMontgomeryPub(newPublicKey)));
  const plaintext = Buffer.from(JSON.stringify(fields));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(metadata(header, context));
    header.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
    header.tag = cipher.getAuthTag().toString('hex');
    return { ...header, signature: authCrypto.signSync(signingMessage(header, context), seed) };
  } finally {
    plaintext.fill(0);
    ephemeral.fill(0);
    key.fill(0);
  }
}

function validateEnvelope(value: unknown, context: string): Envelope {
  if (!value || typeof value !== 'object') throw new Error('Invalid handoff');
  const e = value as Envelope;
  if (e.version !== 1 || !Number.isSafeInteger(e.exported) || e.exported < 0 ||
    !HEX_KEY.test(e.oldPublicKey) || !HEX_KEY.test(e.newPublicKey) || !HEX_KEY.test(e.ephemeralPublicKey) ||
    typeof e.nonce !== 'string' || !/^[0-9a-f]{24}$/.test(e.nonce) ||
    typeof e.tag !== 'string' || !/^[0-9a-f]{32}$/.test(e.tag) ||
    typeof e.ciphertext !== 'string' || typeof e.signature !== 'string' ||
    !authCrypto.verifySync(e.signature, signingMessage(e, context), e.oldPublicKey)) {
    throw new Error('Invalid handoff');
  }
  return e;
}

export function openRotationHandoff(value: unknown, privateKey: string, previousPublicKey: string, context: string): Field[] {
  const e = validateEnvelope(value, context);
  const seed = extractPrivateKeySeed(privateKey);
  if (authCrypto.getPublicKey(seed) !== e.newPublicKey || e.oldPublicKey !== previousPublicKey) {
    throw new Error('Handoff does not match the loaded rotation');
  }
  const xPrivate = edwardsToMontgomeryPriv(Buffer.from(seed, 'hex'));
  const key = encryptionKey(x25519.getSharedSecret(xPrivate, Buffer.from(e.ephemeralPublicKey, 'hex')));
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.nonce, 'hex'));
    decipher.setAAD(metadata(e, context));
    decipher.setAuthTag(Buffer.from(e.tag, 'hex'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'base64')), decipher.final()]);
    const fields: unknown = JSON.parse(plaintext.toString('utf8'));
    if (!Array.isArray(fields) || fields.length !== e.exported ||
      fields.some((item) => !item || !isSweepField(item.field) || typeof item.plaintext !== 'string') ||
      new Set(fields.map((item) => item.field)).size !== fields.length) throw new Error('Invalid handoff fields');
    return fields;
  } finally {
    plaintext?.fill(0);
    xPrivate.fill(0);
    key.fill(0);
  }
}

function handoffPath(): string {
  return `${resolveVaultPath()}.key-rotation.sealed`;
}

async function readEnvelope(filename: string): Promise<Envelope | undefined> {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Handoff unavailable');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_BYTES) {
      throw new Error('Unsafe handoff file');
    }
    return validateEnvelope(JSON.parse(await handle.readFile('utf8')), filename);
  } finally {
    await handle.close();
  }
}

/** Filesystem lock serializes workers. A crash leaves it closed until operator recovery. */
async function withHandoffLock<T>(action: (filename: string) => Promise<T>): Promise<T> {
  const filename = handoffPath();
  const lock = await fs.open(`${filename}.lock`, 'wx', 0o600);
  try {
    return await action(filename);
  } finally {
    await lock.close();
    await fs.unlink(`${filename}.lock`);
  }
}

export async function rotationHandoffStatus() {
  const e = await readEnvelope(handoffPath());
  return e ? { pending: true, exported: e.exported, newPublicKey: e.newPublicKey } : { pending: false };
}

export async function exportRotationHandoff(newPublicKey: string, collect: () => Promise<Field[]>) {
  validateRotationRecipient(newPublicKey);
  return withHandoffLock(async (filename) => {
    if (await readEnvelope(filename)) throw new Error('A handoff is already pending');
    const identity = getNodeSigningIdentity();
    if (!process.env.AUTH_PRIVATE_KEY) throw new Error('Explicit node key required');
    const envelope = sealRotationHandoff(await collect(), newPublicKey, identity.privateKeyHex, filename);
    const bytes = JSON.stringify(envelope);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Handoff too large');
    // Exclusive and fsynced. A partial storage failure is retained and fails
    // closed rather than allowing a later export to overwrite recovery state.
    const handle = await fs.open(filename, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { exported: envelope.exported, newPublicKey };
  });
}

export async function reimportRotationHandoff(store: (field: string, plaintext: string) => Promise<unknown>) {
  return withHandoffLock(async (filename) => {
    const envelope = await readEnvelope(filename);
    if (!envelope || !process.env.AUTH_PRIVATE_KEY || !process.env.AUTH_PREVIOUS_PUBLIC_KEY) {
      throw new Error('No matching rotation handoff');
    }
    const fields = openRotationHandoff(envelope, process.env.AUTH_PRIVATE_KEY, process.env.AUTH_PREVIOUS_PUBLIC_KEY, filename);
    // Keep the complete ciphertext if ANY field fails, for a full roll-forward retry.
    for (const { field, plaintext } of fields) await store(field, plaintext);
    await fs.unlink(filename);
    return { resealed: fields.length };
  });
}
