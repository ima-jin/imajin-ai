/**
 * Protocol-only MJNx issuance. Called by the kernel's in-process bus executor,
 * never by app/user authority or an HTTP credential.
 */
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import type { EmissionExecutorParams, EmissionExecutorResult } from '@imajin/bus';
import { db, transactions } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { MJNX, creditUnit } from './ledger';

const log = createLogger('pay:emission');

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Validate before touching the ledger, including values JSON could not encode. */
function validateEmission(params: EmissionExecutorParams): string | undefined {
  if (!params.to_did || typeof params.to_did !== 'string') return 'to_did is required';
  if (typeof params.amount !== 'number' || !Number.isFinite(params.amount) || params.amount <= 0) {
    return 'amount must be a positive finite number';
  }
  if (params.unit !== MJNX) return `unit must be ${MJNX}`;
  if (!params.reason || typeof params.reason !== 'string') return 'reason is required';
  if (params.metadata !== undefined &&
      (params.metadata === null || typeof params.metadata !== 'object' || Array.isArray(params.metadata))) {
    return 'metadata must be an object';
  }
}

export async function emitMjnx(params: EmissionExecutorParams): Promise<EmissionExecutorResult> {
  const error = validateEmission(params);
  if (error) return { error, status: 400 };
  const { to_did, amount, reason, metadata = {} } = params;
  const attestationId = stringOrNull(metadata.attestation_id);
  const emissionConfigId = stringOrNull(metadata.emission_config_id);
  const emissionConfigVersion = Number.isInteger(metadata.emission_config_version)
    ? (metadata.emission_config_version as number)
    : null;
  const idempotencyKey = stringOrNull(metadata.idempotency_key);
  const txId = generateId('tx');

  // Claim first and credit in the SAME transaction. A duplicate key never
  // credits again; a failed credit rolls back the claim for a safe retry.
  const created = await db.transaction(async (tx) => {
    const claimed = await tx
      .insert(transactions)
      .values({
        id: txId,
        service: 'emissions',
        type: 'emission',
        fromDid: null,
        toDid: to_did,
        amount: String(amount),
        currency: 'MJNx',
        unit: MJNX,
        sourceKind: 'emission',
        attestationId,
        emissionConfigId,
        emissionConfigVersion,
        idempotencyKey,
        status: 'completed',
        source: 'emission',
        metadata: { reason, ...metadata },
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });
    if (claimed.length === 0) return false;
    await creditUnit(tx, to_did, MJNX, amount, { currency: 'MJNx' });
    return true;
  });

  if (!created) {
    const [existing] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.idempotencyKey, idempotencyKey as string))
      .limit(1);
    log.info({ idempotencyKey, txId: existing?.id }, '[emission] duplicate delivery ignored');
    return { id: existing?.id ?? null, amount: String(amount), to_did, status: 'completed', duplicate: true };
  }

  log.info({ amount, toDid: to_did.slice(0, 20), reason, txId }, '[emission] MJNx credited');
  return { id: txId, amount: String(amount), to_did, status: 'completed' };
}
