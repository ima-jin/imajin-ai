import { createLogger } from '@imajin/logger';
import { forEachSequential } from '../concurrency';
import type { ReactorHandler } from '../types';
import { loadEmissionConfig, resolveAmount, resolveTarget } from '../emissions';
import type { EmissionConfig, EmissionRule } from '../emissions';

const log = createLogger('bus:mjn');

export interface EmissionExecutorParams {
  to_did: string;
  amount: number;
  unit: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export type EmissionExecutorResult =
  | { error: string; status: number }
  | { id: string | null; amount: string; to_did: string; status: 'completed'; duplicate?: true };

export type EmissionExecutor = (params: EmissionExecutorParams) => Promise<EmissionExecutorResult>;

// Like settle, share the hook across Next instrumentation and route bundles,
// without importing the kernel from this infrastructure package.
const EXECUTOR_KEY = Symbol.for('@imajin/bus:emission-executor');
type ExecutorHolder = { [EXECUTOR_KEY]?: EmissionExecutor | null };

export function registerEmissionExecutor(executor: EmissionExecutor | null): void {
  (globalThis as ExecutorHolder)[EXECUTOR_KEY] = executor;
}

export function getEmissionExecutor(): EmissionExecutor | undefined {
  return (globalThis as ExecutorHolder)[EXECUTOR_KEY] ?? undefined;
}

/** Delivery attempts per emission before it is reported as failed. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Base backoff between attempts; doubles each retry. */
const DEFAULT_RETRY_DELAY_MS = 250;

interface AttemptResult {
  ok: boolean;
  /** Worth retrying (thrown error, 5xx, 429). Other 4xx errors are permanent. */
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

async function executeEmission(executor: EmissionExecutor, body: EmissionExecutorParams): Promise<AttemptResult> {
  try {
    const result = await executor(body);
    if (!('error' in result)) return { ok: true, retryable: false };

    return {
      ok: false,
      retryable: result.status >= 500 || result.status === 429,
      detail: `${result.status} ${result.error}`,
    };
  } catch (err) {
    return { ok: false, retryable: true, detail: String(err) };
  }
}

/**
 * Execute one emission, retrying transient failures with the same
 * idempotency key, so a retry after a lost result cannot double-credit.
 */
async function deliver(
  executor: EmissionExecutor,
  body: EmissionExecutorParams,
  maxAttempts: number,
  retryDelayMs: number,
  attempt = 1
): Promise<AttemptResult & { attempts: number }> {
  const result = await executeEmission(executor, body);
  if (result.ok || !result.retryable || attempt >= maxAttempts) return { ...result, attempts: attempt };
  await sleep(retryDelayMs * 2 ** (attempt - 1));
  return deliver(executor, body, maxAttempts, retryDelayMs, attempt + 1);
}

interface EmissionContext {
  executor: EmissionExecutor;
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

  const body: EmissionExecutorParams = {
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
  };

  const result = await deliver(ctx.executor, body, ctx.maxAttempts, ctx.retryDelayMs);
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
 *    idempotent (the kernel ledger dedupes on `idempotency_key`). A lost
 *    emission is logged at error level and the reactor throws, so it is
 *    visible — and re-publishing the event is safe.
 */
export const mjnReactor: ReactorHandler = async (event, config) => {

  const attestationType = (config.attestationType as string) || event.type;
  const emission = await loadEmissionConfig(event.type, event.scope, attestationType);
  if (!emission || emission.rules.length === 0) return;
  const executor = getEmissionExecutor();
  if (!executor) {
    throw new Error('mjn: no in-process emission executor registered (emission runs in the kernel process only)');
  }

  const attestationId = typeof event.payload?.attestationId === 'string' ? event.payload.attestationId : undefined;
  if (!attestationId) {
    throw new Error(`mjn: no attestation id on ${event.type} event — refusing untraceable emission`);
  }

  const ctx: EmissionContext = {
    executor,
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

  // Sequential on purpose: emissions credit a ledger (one kernel write per
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
