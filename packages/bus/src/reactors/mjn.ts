import { createLogger } from '@imajin/logger';
import { forEachSequential } from '../concurrency';
import type { ReactorHandler } from '../types';
import { loadEmissionConfig, resolveAmount, resolveTarget } from '../emissions';
import type { EmissionConfig, EmissionRule } from '../emissions';

const log = createLogger('bus:mjn');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY;

/** Delivery attempts per emission before it is reported as failed. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Base backoff between attempts; doubles each retry. */
const DEFAULT_RETRY_DELAY_MS = 250;

interface AttemptResult {
  ok: boolean;
  /** Worth retrying (network error, 5xx, 429). A 4xx is the caller's bug — retrying cannot fix it. */
  retryable: boolean;
  detail?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function postEmission(body: string): Promise<AttemptResult> {
  try {
    const response = await fetch(`${PAY_SERVICE_URL}/api/emission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PAY_SERVICE_API_KEY}`,
      },
      body,
    });
    if (response.ok) return { ok: true, retryable: false };

    const text = await response.text().catch(() => '');
    return {
      ok: false,
      retryable: response.status >= 500 || response.status === 429,
      detail: `HTTP ${response.status} ${text}`.trim(),
    };
  } catch (err) {
    return { ok: false, retryable: true, detail: String(err) };
  }
}

/**
 * POST one emission, retrying transient failures. Every attempt carries the
 * same `idempotency_key` (in the body), which the pay service dedupes on — so
 * a retry after a lost response can never double-credit.
 */
async function deliver(
  body: string,
  maxAttempts: number,
  retryDelayMs: number
): Promise<AttemptResult & { attempts: number }> {
  let result: AttemptResult = { ok: false, retryable: true };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await postEmission(body);
    if (result.ok || !result.retryable || attempt === maxAttempts) return { ...result, attempts: attempt };
    await sleep(retryDelayMs * 2 ** (attempt - 1));
  }
  return { ...result, attempts: maxAttempts };
}

interface EmissionContext {
  attestationType: string;
  attestationId: string;
  emission: EmissionConfig;
  event: Parameters<ReactorHandler>[0];
  settlementCents: number | undefined;
  targets: Parameters<typeof resolveTarget>[1];
  maxAttempts: number;
  retryDelayMs: number;
}

/** Emit one rule. Returns an error string when the emission was lost, otherwise `null`. */
async function emitRule(ctx: EmissionContext, rule: EmissionRule, index: number): Promise<string | null> {
  const { attestationType, attestationId, emission, event } = ctx;

  const targetDid = resolveTarget(rule, ctx.targets);
  if (!targetDid) {
    log.warn({ rule: rule.to, type: attestationType }, '[mjn] No target DID — skipping');
    return null;
  }

  const amount = resolveAmount(rule, ctx.settlementCents);
  if (amount <= 0) return null;

  // One emission per (attestation, rule slot): stable across retries and
  // across a re-publish of the same event.
  const idempotencyKey = `emission:${attestationId}:${index}:${rule.to}`;

  const body = JSON.stringify({
    to_did: targetDid,
    amount,
    unit: emission.unit,
    reason: rule.reason,
    metadata: {
      idempotency_key: idempotencyKey,
      attestation_type: attestationType,
      attestation_id: attestationId,
      emission_config_id: emission.configId,
      emission_config_version: emission.configVersion,
      to_role: rule.to,
      event_type: event.type,
      issuer: event.issuer,
      subject: event.subject,
    },
  });

  const result = await deliver(body, ctx.maxAttempts, ctx.retryDelayMs);
  if (result.ok) {
    log.info(
      { amount, targetDid: targetDid.slice(0, 24), attestationType, reason: rule.reason, attempts: result.attempts },
      '[mjn] MJNx credited'
    );
    return null;
  }

  log.error(
    { targetDid, attestationType, attestationId, idempotencyKey, attempts: result.attempts, detail: result.detail },
    '[mjn] Emission lost after retries'
  );
  return `${idempotencyKey}: ${result.detail ?? 'unknown failure'}`;
}

/**
 * The `mjn` reactor: turns an attestation into MJNx emissions per the
 * schedule in the chain's `kernel.bus_chain_configs` row (#2017).
 *
 *  - Amounts, recipients and unit come from the live row — never from code.
 *  - Each emission records the triggering attestation id and the (id,
 *    version) of the config row that produced it. It needs the attestation
 *    id: the chain runs `attestation` with `await: true` ahead of `mjn` so
 *    `attestationReactor` has stashed `payload.attestationId` on the shared
 *    event. Without it the emission would be untraceable, so it throws.
 *  - Delivery is awaited, retried with backoff on transient failures, and
 *    idempotent (the pay service dedupes on `idempotency_key`). A lost
 *    emission is logged at error level and the reactor throws, so it is
 *    visible — and re-publishing the event is safe.
 */
export const mjnReactor: ReactorHandler = async (event, config) => {
  if (!PAY_SERVICE_URL || !PAY_SERVICE_API_KEY) {
    log.warn({}, 'MJN reactor: PAY_SERVICE_URL or PAY_SERVICE_API_KEY not set');
    return;
  }

  const attestationType = (config.attestationType as string) || event.type;
  const emission = await loadEmissionConfig(event.type, event.scope, attestationType);
  if (!emission || emission.rules.length === 0) return;

  const attestationId = typeof event.payload?.attestationId === 'string' ? event.payload.attestationId : undefined;
  if (!attestationId) {
    throw new Error(`mjn: no attestation id on ${event.type} event — refusing untraceable emission`);
  }

  const ctx: EmissionContext = {
    attestationType,
    attestationId,
    emission,
    event,
    // Settlement value for percentage-based emissions
    settlementCents: typeof event.payload?.amount === 'number' ? event.payload.amount : undefined,
    targets: {
      issuerDid: event.issuer,
      subjectDid: event.subject,
      scopeDid: (event.payload?.scope_did as string) || null,
      nodeDid: null, // see: not yet resolved from config
    },
    // Delivery knobs come from the live row (the `config` the chain handed us may be cached).
    maxAttempts: positiveInt(emission.settings.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    retryDelayMs: nonNegativeNumber(emission.settings.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
  };

  // Sequential on purpose: emissions credit a ledger (one pay-service write per
  // rule, in schedule order) — later credits must not land before earlier ones.
  // A lost rule does not stop the others; failures are collected and thrown.
  const failures: string[] = [];
  await forEachSequential(emission.rules, async (rule, index) => {
    const failure = await emitRule(ctx, rule, index);
    if (failure) failures.push(failure);
  });

  if (failures.length > 0) {
    throw new Error(
      `mjn: ${failures.length}/${emission.rules.length} emission(s) lost for ${attestationType} ` +
        `(attestation ${attestationId}, config ${emission.configId} v${emission.configVersion}): ${failures.join('; ')}`
    );
  }
};
