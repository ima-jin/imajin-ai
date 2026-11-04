import type { ReactorHandler } from '../types';
interface UsageProjectionPayload extends Record<string, unknown> {
  usageId: string;
  actingFor: string;
  source: string;
  resource: string;
  provider: string;
  model: string;
  ts: string;
  sessionId?: string | null;
  turnId?: string | null;
  agentDid?: string | null;
  connectorId?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costEstimateUsd?: number | null;
  quantity?: number | null;
  unit?: string | null;
  transactionId?: string | null;
  externalId?: string | null;
  status?: string | null;
  pricing?: Record<string, unknown> | null;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePayload(payload: Record<string, unknown>): asserts payload is UsageProjectionPayload {
  for (const field of ['usageId', 'actingFor', 'source', 'resource', 'provider', 'model', 'ts']) {
    if (!nonemptyString(payload[field])) {
      throw new TypeError(`Invalid usage receipt: ${field} is required`);
    }
  }
  if (!Number.isFinite(Date.parse(payload.ts as string))) {
    throw new TypeError('Invalid usage receipt: ts must be a valid timestamp');
  }
  for (const field of ['sessionId', 'turnId', 'agentDid', 'connectorId', 'unit', 'transactionId', 'externalId', 'status']) {
    if (payload[field] != null && !nonemptyString(payload[field])) {
      throw new TypeError(`Invalid usage receipt: ${field} must be a nonempty string`);
    }
  }
  validateNumericFields(payload);
  if (payload.pricing != null && (typeof payload.pricing !== 'object' || Array.isArray(payload.pricing))) {
    throw new TypeError('Invalid usage receipt: pricing must be an object');
  }
}

function validateNumericFields(payload: Record<string, unknown>): void {
  for (const field of ['quantity', 'costEstimateUsd', 'tokensIn', 'tokensOut']) {
    const value = payload[field];
    if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new TypeError(`Invalid usage receipt: ${field} must be a finite nonnegative number`);
    }
  }
  for (const field of ['tokensIn', 'tokensOut']) {
    const value = payload[field];
    if (value != null && (!Number.isInteger(value) || (value as number) > 2_147_483_647)) {
      throw new TypeError(`Invalid usage receipt: ${field} must fit a nonnegative SQL integer`);
    }
  }
}

/**
 * Materialize only the existing usage.incurred table, from receipt data alone.
 * usageId (= context_id) is the row PK and stable replay key, not a newly
 * generated bus/attestation id. Legacy direct writers therefore coexist with
 * this projection without duplicating or rewriting their rows.
 */
export const usageProjectionReactor: ReactorHandler = async (event) => {
  if (event.type !== 'usage.incurred') return;
  const payload = event.payload ?? {};
  validatePayload(payload);

  const { getClient } = await import('@imajin/db');
  const sql = getClient();
  await sql`
    INSERT INTO usage.incurred
      (id, principal_did, source, resource, provider, model, session_id, turn_id,
       agent_did, connector_id, tokens_in, tokens_out, cost_usd, quantity, unit,
       transaction_id, external_id, status, pricing, created_at)
    VALUES
      (${payload.usageId}, ${payload.actingFor}, ${payload.source}, ${payload.resource},
       ${payload.provider}, ${payload.model}, ${payload.sessionId ?? null}, ${payload.turnId ?? null},
       ${payload.agentDid ?? null}, ${payload.connectorId ?? null},
       ${payload.tokensIn ?? null}, ${payload.tokensOut ?? null},
       ${payload.costEstimateUsd?.toFixed(8) ?? null},
       ${payload.quantity?.toFixed(6) ?? null},
       ${payload.unit ?? null}, ${payload.transactionId ?? null}, ${payload.externalId ?? null},
       ${payload.status ?? null}, ${payload.pricing == null ? null : JSON.stringify(payload.pricing)}::jsonb,
       ${payload.ts}::timestamptz)
    ON CONFLICT (id) DO NOTHING
  `;
};
