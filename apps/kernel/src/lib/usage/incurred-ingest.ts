/**
 * `POST /usage/api/incurred` batch validation (#1151) — pure, DB-free.
 *
 * Mirrors the `telemetry-ingest.ts` split: no request/response, no `db`, so
 * the row-shape rules are unit-testable without a database and the route
 * itself stays thin. A batch fails outright only for structural problems
 * with the envelope (not an array, empty, over the size cap); once the
 * envelope is sound, each row is validated independently — one bad row in a
 * batch of fifty does not sink the other forty-nine.
 *
 * `quantity`/`unit` are #1148's emitter-agnostic primitive
 * (migrations/0120_usage_incurred_quantity.sql) — an emitter may send them
 * explicitly; when it sends neither, the route derives them from
 * `tokens_in`/`tokens_out` the same way the completions passthrough does
 * (usage-ledger.ts).
 */

/** Hard ceiling on rows per request — batch/periodic reporting, not a streaming firehose. */
export const MAX_INCURRED_BATCH_SIZE = 500;

/** One raw row as external emitters send it. */
export interface RawIncurredRow {
  source?: unknown;
  resource?: unknown;
  quantity?: unknown;
  unit?: unknown;
  provider?: unknown;
  model?: unknown;
  tokens_in?: unknown;
  tokens_out?: unknown;
  cost_usd?: unknown;
  external_id?: unknown;
  ts?: unknown;
  acting_for?: unknown;
}

/** One validated row, ready to resolve against the emitter registry and insert. */
export interface ValidatedIncurredRow {
  /** Index of this row in the ORIGINAL raw batch — for correlating failures after validation. */
  index: number;
  source: string;
  resource: string;
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  quantity?: number;
  unit?: string;
  externalId: string;
  ts: Date;
  actingFor?: string;
}

/** Why one row in a batch was rejected, with its index for correlation. */
export interface RejectedIncurredRow {
  index: number;
  reason: string;
}

export interface IncurredBatchValidation {
  accepted: ValidatedIncurredRow[];
  rejected: RejectedIncurredRow[];
}

/** `model:{provider}/{model}` | `tool:*` | `infra:*` | `external:*` — #1147's cross-emitter discriminator. */
const RESOURCE_PATTERN = /^(model|tool|infra|external):\S+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

type FieldError = { ok: false; reason: string };
type FieldOk<T> = { ok: true; value: T };

/** Validate the fields every row must have. */
function validateRequiredFields(
  raw: Record<string, unknown>,
): FieldOk<{ source: string; resource: string; externalId: string; ts: Date }> | FieldError {
  const { source, resource, external_id, ts } = raw;

  if (!isNonEmptyString(source)) {
    return { ok: false, reason: 'source must be a non-empty string' };
  }
  if (!isNonEmptyString(resource) || !RESOURCE_PATTERN.test(resource)) {
    return { ok: false, reason: "resource must be shaped 'model:*' | 'tool:*' | 'infra:*' | 'external:*'" };
  }
  if (!isNonEmptyString(external_id)) {
    return { ok: false, reason: 'external_id must be a non-empty string (the dedupe key)' };
  }
  if (!isNonEmptyString(ts)) {
    return { ok: false, reason: 'ts must be an ISO 8601 timestamp string' };
  }
  const parsedTs = new Date(ts);
  if (Number.isNaN(parsedTs.getTime())) {
    return { ok: false, reason: 'ts must be a valid ISO 8601 timestamp' };
  }

  return { ok: true, value: { source, resource, externalId: external_id, ts: parsedTs } };
}

/** Fields every row may optionally carry, normalized to their camelCase output names. */
interface OptionalFields {
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  quantity?: number;
  unit?: string;
  actingFor?: string;
}

/** One (raw key, validated key, validator) triple per optional field — data-driven so adding a field is one row, not another `if`. */
const OPTIONAL_FIELD_RULES = [
  { rawKey: 'provider', outKey: 'provider', check: isNonEmptyString, message: 'provider must be a string when present' },
  { rawKey: 'model', outKey: 'model', check: isNonEmptyString, message: 'model must be a string when present' },
  { rawKey: 'tokens_in', outKey: 'tokensIn', check: isFiniteNumber, message: 'tokens_in must be a number when present' },
  { rawKey: 'tokens_out', outKey: 'tokensOut', check: isFiniteNumber, message: 'tokens_out must be a number when present' },
  { rawKey: 'cost_usd', outKey: 'costUsd', check: isFiniteNumber, message: 'cost_usd must be a number when present' },
  // #1148 emitter-agnostic quantity/unit — an emitter may report these
  // directly instead of (or alongside) tokens_in/tokens_out.
  { rawKey: 'quantity', outKey: 'quantity', check: isFiniteNumber, message: 'quantity must be a number when present' },
  { rawKey: 'unit', outKey: 'unit', check: isNonEmptyString, message: 'unit must be a string when present' },
  { rawKey: 'acting_for', outKey: 'actingFor', check: isNonEmptyString, message: 'acting_for must be a string when present' },
] as const satisfies ReadonlyArray<{ rawKey: string; outKey: keyof OptionalFields; check: (v: unknown) => boolean; message: string }>;

/** Validate and normalize the optional fields, or the first rejection reason encountered. */
function validateOptionalFields(raw: Record<string, unknown>): FieldOk<OptionalFields> | FieldError {
  const value: OptionalFields = {};
  for (const rule of OPTIONAL_FIELD_RULES) {
    const rawValue = raw[rule.rawKey];
    if (rawValue === undefined) continue;
    if (!rule.check(rawValue)) {
      return { ok: false, reason: rule.message };
    }
    (value as Record<string, unknown>)[rule.outKey] = rawValue;
  }
  return { ok: true, value };
}

/** Validate one raw row. Returns either the normalized row or a rejection reason. */
function validateOne(raw: unknown, index: number): { ok: true; row: ValidatedIncurredRow } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'row must be an object' };
  }

  const required = validateRequiredFields(raw);
  if (!required.ok) return required;

  const optional = validateOptionalFields(raw);
  if (!optional.ok) return optional;

  return {
    ok: true,
    row: { index, ...required.value, ...optional.value },
  };
}

/**
 * Validate a raw request body's row array.
 */
export function validateIncurredBatch(rawRows: unknown): IncurredBatchValidation | { error: string } {
  if (!Array.isArray(rawRows)) {
    return { error: 'body must be an array of rows' };
  }
  if (rawRows.length === 0) {
    return { error: 'body must not be empty' };
  }
  if (rawRows.length > MAX_INCURRED_BATCH_SIZE) {
    return { error: `body may not exceed ${MAX_INCURRED_BATCH_SIZE} rows per request` };
  }

  const accepted: ValidatedIncurredRow[] = [];
  const rejected: RejectedIncurredRow[] = [];

  rawRows.forEach((raw, index) => {
    const result = validateOne(raw, index);
    if (result.ok) {
      accepted.push(result.row);
    } else {
      rejected.push({ index, reason: result.reason });
    }
  });

  return { accepted, rejected };
}

/** `model:{provider}/{model}` parsed back out, or undefined for a non-model resource. */
function parseModelResource(resource: string): { provider: string; model: string } | undefined {
  const match = /^model:([^/]+)\/(.+)$/.exec(resource);
  if (!match) return undefined;
  return { provider: match[1], model: match[2] };
}

/**
 * Derive the `provider`/`model` columns `usage.incurred` still requires
 * NOT NULL (out of scope to alter here — see migrations/0121's header).
 *
 * Prefers whatever the row explicitly sent; for a `model:*` resource, falls
 * back to parsing `{provider}/{model}` out of it; for any other resource
 * kind (`tool:*`/`infra:*`/`external:*`, which have no natural
 * provider/model pair), falls back to the resource's own `kind`/value
 * segments so the row can still be written rather than rejected outright.
 */
export function deriveProviderModel(row: Pick<ValidatedIncurredRow, 'resource' | 'provider' | 'model'>): { provider: string; model: string } {
  const parsed = parseModelResource(row.resource);
  if (row.provider && row.model) return { provider: row.provider, model: row.model };

  const [kind, ...rest] = row.resource.split(':');
  const fallbackModel = rest.join(':') || row.resource;

  return {
    provider: row.provider ?? parsed?.provider ?? kind,
    model: row.model ?? parsed?.model ?? fallbackModel,
  };
}

/**
 * Derive #1148's emitter-agnostic `quantity`/`unit` pair. Honors whatever the
 * row explicitly sent; when it sends neither, falls back to
 * `tokensIn + tokensOut` / `'tokens'` — the exact rule
 * `recordInferenceUsage` (usage-ledger.ts) uses for the completions
 * passthrough — whenever both token counts are known. `undefined`/`undefined`
 * when none of quantity, unit, or both token counts are present.
 */
export function deriveQuantityUnit(
  row: Pick<ValidatedIncurredRow, 'quantity' | 'unit' | 'tokensIn' | 'tokensOut'>,
): { quantity: number | undefined; unit: string | undefined } {
  if (row.quantity !== undefined) {
    return { quantity: row.quantity, unit: row.unit };
  }
  if (row.tokensIn !== undefined && row.tokensOut !== undefined) {
    return { quantity: row.tokensIn + row.tokensOut, unit: row.unit ?? 'tokens' };
  }
  return { quantity: undefined, unit: row.unit };
}
