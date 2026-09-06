/**
 * POST /usage/api/receipts (#1951)
 *
 * Confirms a receipt's (possibly Qwen-drafted, possibly manually typed)
 * structured line items and persists them. Auth: `requireAuth` +
 * `resolveActingDid` — onBehalfOf the resolved principal DID, same
 * "owner, or a registered agent already delegated via `actingFor`" rule
 * every other `usage/api/*` write uses.
 *
 * Writes N `usage.billed` rows (one per confirmed line item, sharing one
 * `receiptId`) plus ONE binding attestation on the principal's own DID —
 * NEVER `usage.incurred` (D5: never merge, only reconcile). This is the
 * ONLY call that ever attests a receipt — `POST /usage/api/receipts/extract`
 * (Qwen-assist) only ever returns an unconfirmed draft.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { confirmReceiptLines, type ReceiptLineInput } from '@/src/lib/usage/billed/receipt';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

/** ISO 4217-shaped currency code (3 uppercase letters). FX conversion (packages/money) handles anything other than USD. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const MAX_LINES = 200;
const MAX_VENDOR_LENGTH = 128;
const MAX_CATEGORY_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface LineRequestBody {
  description?: unknown;
  category?: unknown;
  amountMinor?: unknown;
  date?: unknown;
  vendor?: unknown;
  currency?: unknown;
}

interface ReceiptRequestBody {
  assetId?: unknown;
  currency?: unknown;
  receiptTotalMinor?: unknown;
  lines?: unknown;
}

function validateLine(
  raw: unknown,
  index: number,
  receiptCurrency: string,
): { value: ReceiptLineInput } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: `lines[${index}] must be an object` };
  const line = raw as LineRequestBody;

  if (typeof line.description !== 'string' || !line.description.trim()) {
    return { error: `lines[${index}].description is required` };
  }
  if (line.description.trim().length > MAX_DESCRIPTION_LENGTH) {
    return { error: `lines[${index}].description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` };
  }
  if (typeof line.vendor !== 'string' || !line.vendor.trim()) {
    return { error: `lines[${index}].vendor is required` };
  }
  if (line.vendor.trim().length > MAX_VENDOR_LENGTH) {
    return { error: `lines[${index}].vendor must be ${MAX_VENDOR_LENGTH} characters or fewer` };
  }
  if (typeof line.amountMinor !== 'number' || !Number.isInteger(line.amountMinor) || line.amountMinor < 0) {
    return { error: `lines[${index}].amountMinor must be an integer >= 0 (minor units)` };
  }
  if (line.category !== undefined && line.category !== null) {
    if (typeof line.category !== 'string' || line.category.length > MAX_CATEGORY_LENGTH) {
      return { error: `lines[${index}].category must be a string of ${MAX_CATEGORY_LENGTH} characters or fewer` };
    }
  }
  if (line.currency !== undefined && line.currency !== receiptCurrency) {
    return { error: `lines[${index}].currency must match the receipt's currency (${receiptCurrency})` };
  }
  if (typeof line.date !== 'string') return { error: `lines[${index}].date is required (ISO date string)` };
  const date = new Date(line.date);
  if (Number.isNaN(date.getTime())) return { error: `lines[${index}].date must be a valid date` };

  return {
    value: {
      description: line.description.trim(),
      category: typeof line.category === 'string' ? line.category : null,
      amountMinor: line.amountMinor,
      date,
      vendor: line.vendor.trim(),
    },
  };
}

interface ValidatedReceiptBody {
  assetId: string;
  currency: string;
  receiptTotalMinor: number;
  lines: ReceiptLineInput[];
}

function validateReceiptBody(body: ReceiptRequestBody): { value: ValidatedReceiptBody } | { error: string } {
  if (typeof body.assetId !== 'string' || !body.assetId.trim()) return { error: 'assetId is required' };

  if (typeof body.currency !== 'string' || !CURRENCY_PATTERN.test(body.currency)) {
    return { error: 'currency must be a 3-letter uppercase ISO 4217 code (e.g. USD)' };
  }

  if (
    typeof body.receiptTotalMinor !== 'number' ||
    !Number.isInteger(body.receiptTotalMinor) ||
    body.receiptTotalMinor < 0
  ) {
    return { error: 'receiptTotalMinor must be an integer >= 0 (minor units)' };
  }

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return { error: 'lines must be a non-empty array' };
  }
  if (body.lines.length > MAX_LINES) {
    return { error: `lines must contain ${MAX_LINES} items or fewer` };
  }

  const lines: ReceiptLineInput[] = [];
  for (const [index, raw] of body.lines.entries()) {
    const validated = validateLine(raw, index, body.currency);
    if ('error' in validated) return validated;
    lines.push(validated.value);
  }

  return { value: { assetId: body.assetId, currency: body.currency, receiptTotalMinor: body.receiptTotalMinor, lines } };
}

const RECEIPT_ERROR_STATUS: Record<string, number> = {
  evidence_asset_not_found: 404,
  evidence_asset_not_owned: 403,
  empty_lines: 400,
  sum_mismatch: 422,
  fx_unavailable: 502,
};

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const principalDid = resolveActingDid(authResult.identity);

  let body: ReceiptRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const validated = validateReceiptBody(body ?? {});
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400, headers: cors });
  }

  try {
    const result = await confirmReceiptLines({ principalDid, ...validated.value });
    if ('error' in result) {
      const status = RECEIPT_ERROR_STATUS[result.error] ?? 400;
      const detail = 'expectedMinor' in result ? { expectedMinor: result.expectedMinor, actualMinor: result.actualMinor } : {};
      return NextResponse.json({ error: result.error, ...detail }, { status, headers: cors });
    }
    return NextResponse.json(result, { status: 201, headers: cors });
  } catch (err) {
    log.error({ err: String(err), principalDid }, 'receipt confirm write failed');
    return NextResponse.json({ error: 'Failed to record receipt line items' }, { status: 500, headers: cors });
  }
}
