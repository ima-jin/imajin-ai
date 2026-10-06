import { createLogger } from '@imajin/logger';

const log = createLogger('bus:mjn');

/**
 * Emission schedule — configuration, not code (#2017).
 *
 * The schedule lives in the `config` of a chain's `mjn` reactor entry inside a
 * `kernel.bus_chain_configs` row (attestation type → recipients → amount or
 * percent → unit). Node operators edit the row; every edit bumps the row's
 * `version`, and every emission records the (row id, version) that produced
 * it. This module only parses and resolves what the row says — it holds no
 * amounts of its own.
 *
 * Example `reactors` element:
 *
 *   { "type": "mjn", "await": true, "enabled": true,
 *     "config": { "attestationType": "connection.accepted", "unit": "MJNx",
 *                 "emit": [ { "to": "subject", "amount": 1, "reason": "..." },
 *                           { "to": "issuer",  "percent": 0.25, "reason": "..." } ] } }
 *
 * Emissions mint MJNx — the emitted, non-withdrawable unit (#2016) — never MJN.
 * There is no gas: the pre-#2017 `gas` declaration was never debited anywhere
 * and has been deleted rather than left as a phantom field.
 */

export const EMISSION_UNIT = 'MJNx';

const EMISSION_TARGETS = ['subject', 'issuer', 'scope', 'node'] as const;
export type EmissionTarget = (typeof EMISSION_TARGETS)[number];

/** One parsed recipient rule. Exactly one of `amount` / `percent` is set. */
export interface EmissionRule {
  /** Who receives the emission */
  to: EmissionTarget;
  /** Fixed MJNx amount */
  amount?: number;
  /** Percent of the settlement value in `payload.amount` (0.25 means 0.25%) */
  percent?: number;
  /** Human-readable reason for ledger display */
  reason: string;
}

/** A parsed emission schedule plus the provenance of the row it came from. */
export interface EmissionConfig {
  /** `kernel.bus_chain_configs.id` of the row that produced this schedule */
  configId: string;
  /** `kernel.bus_chain_configs.version` of that row at read time */
  configVersion: number;
  unit: typeof EMISSION_UNIT;
  rules: EmissionRule[];
  /** The live row's raw `mjn` entry config — delivery knobs (`maxAttempts`, `retryDelayMs`) live here too. */
  settings: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isEmissionTarget(value: unknown): value is EmissionTarget {
  return (EMISSION_TARGETS as readonly unknown[]).includes(value);
}

function parseRule(raw: unknown, index: number): EmissionRule {
  if (!isRecord(raw)) throw new Error(`emit[${index}] must be an object`);
  if (!isEmissionTarget(raw.to)) throw new Error(`emit[${index}].to must be one of ${EMISSION_TARGETS.join('|')}`);
  if (typeof raw.reason !== 'string' || raw.reason === '') throw new Error(`emit[${index}].reason is required`);

  const hasAmount = raw.amount !== undefined;
  const hasPercent = raw.percent !== undefined;
  if (hasAmount === hasPercent) throw new Error(`emit[${index}] needs exactly one of amount | percent`);
  if (hasAmount && !isNonNegativeNumber(raw.amount)) throw new Error(`emit[${index}].amount must be a non-negative number`);
  if (hasPercent && !isNonNegativeNumber(raw.percent)) throw new Error(`emit[${index}].percent must be a non-negative number`);

  return {
    to: raw.to,
    reason: raw.reason,
    ...(hasAmount ? { amount: raw.amount as number } : { percent: raw.percent as number }),
  };
}

/**
 * Parse the `emit` / `unit` fields of a `mjn` reactor config. Throws on a
 * malformed schedule so a bad operator edit is loud rather than silently
 * emitting nothing (or the wrong thing).
 */
export function parseEmissionRules(config: Record<string, unknown>): EmissionRule[] {
  const unit = config.unit ?? EMISSION_UNIT;
  if (unit !== EMISSION_UNIT) throw new Error(`emission unit must be ${EMISSION_UNIT}, got ${String(unit)}`);
  if (!Array.isArray(config.emit)) throw new Error('mjn reactor config has no emit[] schedule');
  return config.emit.map((raw, index) => parseRule(raw, index));
}

/**
 * Resolve a rule to an MJNx amount.
 *
 * A fixed `amount` is returned as-is. A `percent` applies to the settlement
 * value (fiat cents, e.g. 1000 = $10.00): cents → dollars, apply the percent,
 * then dollars → MJNx at $0.01 per unit, floored to 2 decimal places.
 *
 * Example: 0.25% of $10.00 (1000 cents) = $0.025 = 2.5 MJNx
 */
export function resolveAmount(rule: EmissionRule, settlementCents?: number): number {
  if (rule.amount !== undefined) return rule.amount;

  const fraction = (rule.percent ?? 0) / 100;
  const baseDollars = (settlementCents ?? 0) / 100; // cents → dollars
  const dollarAmount = baseDollars * fraction;      // percent of dollars
  const units = dollarAmount * 100;                 // dollars → MJNx ($0.01 per unit)
  return Math.floor(units * 100) / 100;             // floor to 2 decimal places
}

/**
 * Resolve the target DID for an emission rule.
 */
export function resolveTarget(
  rule: EmissionRule,
  attestation: { issuerDid: string; subjectDid: string; scopeDid?: string | null; nodeDid?: string | null }
): string | null {
  switch (rule.to) {
    case 'subject': return attestation.subjectDid;
    case 'issuer': return attestation.issuerDid;
    case 'scope': return attestation.scopeDid ?? null;
    case 'node': return attestation.nodeDid ?? null;
    default: return null;
  }
}

interface ChainRow {
  id: string;
  version: number;
  reactors: unknown;
  enabled: boolean;
}

/**
 * Read the live chain row for (eventType, scope) — scoped match first, then
 * the node default (scope IS NULL), the same precedence `getChainConfig`
 * uses. Deliberately uncached: `getChainConfig` memoises for 5 minutes, and
 * an operator's edit must govern the very next emission.
 */
async function readChainRow(eventType: string, scope: string): Promise<ChainRow | null> {
  const { getClient } = await import('@imajin/db');
  const sql = getClient();

  const scoped = await sql`
    SELECT id, version, reactors, enabled
    FROM kernel.bus_chain_configs
    WHERE event_type = ${eventType}
      AND scope = ${scope}
    LIMIT 1
  `;
  if (scoped.length > 0) return scoped[0] as unknown as ChainRow;

  const fallback = await sql`
    SELECT id, version, reactors, enabled
    FROM kernel.bus_chain_configs
    WHERE event_type = ${eventType}
      AND scope IS NULL
    LIMIT 1
  `;
  return fallback.length > 0 ? (fallback[0] as unknown as ChainRow) : null;
}

/**
 * Load the emission schedule for an attestation type from the live chain row
 * of the event that triggered it. Returns `null` when there is no row, the
 * row is disabled, or it carries no enabled `mjn` entry for the type — i.e.
 * the node has configured no emission for it.
 */
export async function loadEmissionConfig(
  eventType: string,
  scope: string,
  attestationType: string
): Promise<EmissionConfig | null> {
  const row = await readChainRow(eventType, scope);
  if (!row?.enabled || !Array.isArray(row.reactors)) return null;

  const entry = (row.reactors as unknown[]).find(
    (reactor): reactor is { config: Record<string, unknown> } =>
      isRecord(reactor) &&
      reactor.type === 'mjn' &&
      reactor.enabled !== false &&
      isRecord(reactor.config) &&
      (reactor.config.attestationType ?? eventType) === attestationType
  );
  if (!entry) return null;

  let rules: EmissionRule[];
  try {
    rules = parseEmissionRules(entry.config);
  } catch (err) {
    log.error({ err: String(err), configId: row.id, eventType }, '[mjn] Invalid emission schedule in bus_chain_configs row');
    throw err;
  }

  return { configId: row.id, configVersion: Number(row.version), unit: EMISSION_UNIT, rules, settings: entry.config };
}
