import type { BrokerRequest } from '@imajin/bus';

export interface ParsedBrokerRequest {
  type: string;
  requester: string;
  subject: string;
  purpose: string;
  fields: string[];
  scope: string;
  data?: Record<string, unknown>;
  predicates?: BrokerRequest['predicates'];
  preview: boolean;
  mode: 'enforce' | 'shadow';
}

export type ParseBrokerRequestResult =
  | { ok: true; request: ParsedBrokerRequest }
  | { ok: false; error: string; status: number };

interface RawBrokerFields {
  type: string | null;
  requester: string | null;
  subject: string | null;
  purpose: string | null;
  fields: string[] | null;
  scope: string;
  data?: Record<string, unknown>;
  predicates?: BrokerRequest['predicates'];
  preview: boolean;
  mode: unknown;
}

/** Pull the broker request fields out of the raw JSON body, coercing/trimming as needed. */
function extractBrokerFields(body: Record<string, unknown>): RawBrokerFields {
  const asTrimmedString = (value: unknown): string | null => (typeof value === 'string' ? value.trim() : null);
  const asObject = (value: unknown): Record<string, unknown> | undefined =>
    (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined);
  const asPlainObject = (value: unknown): Record<string, unknown> | undefined =>
    (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

  return {
    type: asTrimmedString(body.type),
    requester: asTrimmedString(body.requester),
    subject: asTrimmedString(body.subject),
    purpose: asTrimmedString(body.purpose),
    fields: Array.isArray(body.fields)
      ? (body.fields as unknown[]).filter((f): f is string => typeof f === 'string')
      : null,
    scope: typeof body.scope === 'string' ? body.scope : 'default',
    data: asObject(body.data),
    predicates: asPlainObject(body.predicates) as BrokerRequest['predicates'] | undefined,
    preview: body.preview === true,
    mode: body.mode === undefined ? 'enforce' : body.mode,
  };
}

/** Validate the extracted fields, returning the first failure in field-declaration order. */
function validateBrokerFields(raw: RawBrokerFields): { error: string; status: number } | null {
  if (!raw.type) return { error: 'type is required', status: 400 };
  if (!raw.requester) return { error: 'requester is required', status: 400 };
  if (!raw.subject) return { error: 'subject is required', status: 400 };
  if (!raw.purpose) return { error: 'purpose is required', status: 400 };
  if (!raw.fields || raw.fields.length === 0) {
    return { error: 'fields must be a non-empty string array', status: 400 };
  }
  if (raw.mode !== 'enforce' && raw.mode !== 'shadow') {
    return { error: "mode must be 'enforce' or 'shadow'", status: 400 };
  }
  return null;
}

/**
 * Parse and validate the broker request body. Returns a typed, fully
 * validated request on success, or the first validation failure encountered
 * (matching the original field-by-field check order).
 */
export function parseBrokerRequestBody(body: Record<string, unknown>): ParseBrokerRequestResult {
  const raw = extractBrokerFields(body);
  const failure = validateBrokerFields(raw);
  if (failure) return { ok: false, ...failure };

  const { type, requester, subject, purpose, fields, scope, data, predicates, preview, mode } = raw;
  return {
    ok: true,
    request: {
      type: type!, requester: requester!, subject: subject!, purpose: purpose!, fields: fields!,
      scope, data, predicates, preview, mode: mode as 'enforce' | 'shadow',
    },
  };
}
