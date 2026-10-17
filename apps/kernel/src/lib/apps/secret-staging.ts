/**
 * Pending operator input is sealed outside proposals. The existing provisioning
 * claim table supplies a durable, cross-process single-use marker, NOT a grant.
 * A failed/expired attempt must be submitted again; plaintext is never cached.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, internalSecretProvisions } from '@/src/db';
import { sealAndStore, loadAndUnseal, deleteFromVault } from '@/src/lib/vault';
import { getNodeSigningIdentity, isVaultTier1 } from '@/src/lib/vault/sealing';

export interface AppSecretStagingBinding {
  proposalId: string;
  operatorDid: string;
  appDid: string;
  name: string;
  action: 'set' | 'rotate';
}
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isAppSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 65_536;
}

function location(ref: string) {
  if (!REF_PATTERN.test(ref)) throw new Error('App-secret staging unavailable');
  const purpose = `app-self:staging:${ref}`;
  return { purpose, field: `internal-secret:${purpose}` };
}

export async function stageAppSecret(binding: AppSecretStagingBinding, value: string): Promise<string> {
  try {
    if (isVaultTier1() || !isAppSecretValue(value)) throw new Error('Unavailable');
    const ref = randomUUID();
    const { purpose, field } = location(ref);
    await sealAndStore(field, JSON.stringify({ ...binding, value, expiresAt: Date.now() + STAGING_TTL_MS }));
    await db.insert(internalSecretProvisions).values({
      id: ref, ownerDid: getNodeSigningIdentity().senderDid, purpose, field,
    });
    return ref;
  } catch {
    throw new Error('App-secret staging unavailable');
  }
}

export async function consumeAppSecret(ref: string, binding: AppSecretStagingBinding): Promise<string> {
  try {
    const { purpose, field } = location(ref);
    const sealed = await loadAndUnseal(field);
    if (!sealed) throw new Error('Unavailable');
    const staged = JSON.parse(sealed) as Record<string, unknown>;
    if (!Object.entries(binding).every(([key, value]) => staged[key] === value)
      || typeof staged.expiresAt !== 'number' || staged.expiresAt <= Date.now()
      || !isAppSecretValue(staged.value)) throw new Error('Unavailable');
    // DELETE RETURNING elects exactly one executor, including across processes.
    const claimed = await db.delete(internalSecretProvisions).where(and(
      eq(internalSecretProvisions.id, ref),
      eq(internalSecretProvisions.ownerDid, getNodeSigningIdentity().senderDid),
      eq(internalSecretProvisions.purpose, purpose),
      eq(internalSecretProvisions.field, field),
    )).returning({ id: internalSecretProvisions.id });
    if (claimed.length !== 1) throw new Error('Unavailable');
    await deleteFromVault(field);
    return staged.value;
  } catch {
    throw new Error('App-secret staging unavailable');
  }
}
