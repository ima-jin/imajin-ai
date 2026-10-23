import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, attestations, vaultMintedKeys, type VaultMintedKey } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { forEachSequential } from '@/src/lib/async/sequential';
import { mintKeypair } from './mint';
import { revokeStaticSecretGrant } from './index';
import { getNodeSigningIdentity, isVaultTier1 } from './sealing';
import { isSshCaField } from './field-grammar';
import { isSshCaPurpose, SSH_CA_MAX_CERT_TTL_SECONDS } from './ssh-ca-policy';
import type { MintAuthority } from './mint-authority';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Action = 'minted' | 'rotated' | 'revoked' | 'retired';

export class SshCaError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** RFC 8709: two SSH strings, algorithm name followed by the 32-byte public key. */
export function sshCaPublicKey(publicKey: string, purpose: string, caId: string) {
  if (!/^[a-f0-9]{64}$/i.test(publicKey)) throw new Error('Invalid CA public key');
  const algorithm = Buffer.from('ssh-ed25519');
  const wire = Buffer.alloc(4 + algorithm.length + 4 + 32);
  wire.writeUInt32BE(algorithm.length, 0);
  algorithm.copy(wire, 4);
  wire.writeUInt32BE(32, 4 + algorithm.length);
  Buffer.from(publicKey, 'hex').copy(wire, 8 + algorithm.length);
  return {
    publicKey: `ssh-ed25519 ${wire.toString('base64')} imajin-ssh-ca:${purpose}:${caId}`,
    fingerprint: `SHA256:${createHash('sha256').update(wire).digest('base64url').replaceAll('-', '+').replaceAll('_', '/')}`,
  };
}

function publicRecord(row: Pick<VaultMintedKey, 'id' | 'publicKey' | 'status'>, purpose: string) {
  return { caId: row.id, purpose, status: row.status, ...sshCaPublicKey(row.publicKey, purpose, row.id) };
}

/** Same lock must cover #3064's active lookup and signing, never a cached signer. */
export async function lockSshCaPurpose(tx: Transaction, purpose: string) {
  if (!isSshCaPurpose(purpose)) throw new SshCaError(400, 'Invalid SSH CA purpose');
  const lockKey = `vault.ssh-ca:${purpose}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

async function records(tx: Transaction, purpose: string) {
  const rows = await tx.select().from(vaultMintedKeys).where(eq(vaultMintedKeys.purpose, `ssh-ca:${purpose}`));
  return rows.filter(row => isSshCaField(row.field));
}

async function attest(tx: Transaction, action: Action, row: Pick<VaultMintedKey, 'id' | 'did' | 'publicKey' | 'status'>,
  purpose: string, authority: MintAuthority, extra: Record<string, unknown> = {}) {
  const audit = await prepareMechanicalAttestation({
    subjectDid: row.did, type: `vault.ssh-ca.${action}`, contextId: row.id, contextType: 'vault.ssh-ca',
    payload: {
      caId: row.id, purpose, actor: authority.actingDid, composedBy: authority.composedBy,
      fingerprint: sshCaPublicKey(row.publicKey, purpose, row.id).fingerprint, ...extra,
    },
  });
  await tx.insert(attestations).values(audit);
}

/**
 * revokedAt is when the private signing grant was withdrawn, not when public
 * trust ends. A retiring key remains trusted for precisely MAX_CERT_TTL after it.
 * All records and attestations survive; no rows or sealed history are deleted.
 */
function retire(tx: Transaction, rows: VaultMintedKey[], purpose: string, now: Date) {
  return forEachSequential(rows, async row => {
    if (row.status !== 'retiring') return;
    if (!row.revokedAt) throw new Error('Invalid CA retirement state');
    if (row.revokedAt.getTime() + SSH_CA_MAX_CERT_TTL_SECONDS * 1000 > now.getTime()) return;
    await attest(tx, 'retired', row, purpose, {
      actingDid: getNodeSigningIdentity().senderDid, composedBy: null,
    }, { signingStoppedAt: row.revokedAt.toISOString() });
    await tx.update(vaultMintedKeys).set({ status: 'retired' }).where(eq(vaultMintedKeys.id, row.id));
    row.status = 'retired';
  });
}

/** Tier 1 cannot synchronously self-grant; refuse before generating a key. */
export function mintSshCa(purpose: string, authority: MintAuthority, rotate = false) {
  if (isVaultTier1()) throw new SshCaError(409, 'SSH CA requires kernel custody');
  return db.transaction(async tx => {
    await lockSshCaPurpose(tx, purpose);
    const rows = await records(tx, purpose);
    const active = rows.filter(row => row.status === 'active');
    if (active.length > 1) throw new Error('Ambiguous CA signer');
    if (!rotate && active.length) throw new SshCaError(409, 'SSH CA already exists; rotate it');
    if (rotate && !active.length) throw new SshCaError(404, 'No active SSH CA for this purpose');
    const minted = await mintKeypair({
      purpose: `ssh-ca:${purpose}`, requesterDid: getNodeSigningIdentity().senderDid,
      mintedBy: authority.actingDid, oneTime: false, custody: 'ssh-ca', tx,
    });
    if (!minted.grantId) throw new Error('CA custody unavailable');
    const next = { id: minted.mintId, did: minted.did, publicKey: minted.publicKey, status: 'active' };
    await attest(tx, 'minted', next, purpose, authority);
    // Take the cutoff AFTER the replacement is sealed and the previous signer is locked out.
    const now = new Date();
    const previous = active[0];
    if (previous) {
      await revokeStaticSecretGrant(previous.field, previous.requestedBy, tx);
      await tx.update(vaultMintedKeys).set({
        status: 'retiring', revokedAt: now, revokedBy: authority.actingDid,
      }).where(eq(vaultMintedKeys.id, previous.id));
      await attest(tx, 'rotated', next, purpose, authority, {
        previousCaId: previous.id,
        previousFingerprint: sshCaPublicKey(previous.publicKey, purpose, previous.id).fingerprint,
        previousTrustedUntil: new Date(now.getTime() + SSH_CA_MAX_CERT_TTL_SECONDS * 1000).toISOString(),
      });
    }
    await retire(tx, rows, purpose, now);
    return publicRecord(next, purpose);
  });
}

export function revokeSshCa(purpose: string, caId: string, authority: MintAuthority) {
  return db.transaction(async tx => {
    await lockSshCaPurpose(tx, purpose);
    const row = (await records(tx, purpose)).find(record => record.id === caId);
    if (!row) throw new SshCaError(404, 'SSH CA not found');
    if (row.status === 'revoked') return { caId, alreadyRevoked: true };
    await revokeStaticSecretGrant(row.field, row.requestedBy, tx);
    await attest(tx, 'revoked', row, purpose, authority);
    await tx.update(vaultMintedKeys).set({
      status: 'revoked', revokedAt: new Date(), revokedBy: authority.actingDid,
    }).where(eq(vaultMintedKeys.id, caId));
    return { caId, alreadyRevoked: false };
  });
}

/** Public trust projection: retirement is reconciled on every read, even after restart. */
export function trustedSshCaKeys(purpose: string): Promise<string> {
  return db.transaction(async tx => {
    await lockSshCaPurpose(tx, purpose);
    const rows = await records(tx, purpose);
    await retire(tx, rows, purpose, new Date());
    const keys = rows.filter(row => row.status === 'active' || row.status === 'retiring')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(row => publicRecord(row, purpose).publicKey);
    return keys.length ? `${keys.join('\n')}\n` : '';
  });
}
