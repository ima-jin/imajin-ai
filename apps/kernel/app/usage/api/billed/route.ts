/**
 * POST /usage/api/billed (#2030)
 *
 * Manual / backfill write, widening #1951 D4 "manual entry v1". Auth:
 * `requireAuth` + `resolveActingDid` — onBehalfOf the resolved principal
 * DID (same "owner, or a registered agent already delegated via
 * `actingFor`" rule every other `usage/api/*` read uses). `period` may be
 * in the past; this is explicitly a backfill path.
 *
 * Writes ONE `usage.billed` row plus a binding `usage.billed` attestation
 * on the principal's own DID (see `lib/usage/billed/manual.ts`) — NEVER
 * `usage.incurred` (D5: never merge, only reconcile).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { insertManualBilledLine, type ManualBilledSource } from '@/src/lib/usage/billed/manual';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

const VALID_SOURCES: ReadonlySet<ManualBilledSource> = new Set(['manual', 'document']);

/** ISO 4217-shaped currency code (3 uppercase letters). Format only — see SUPPORTED_CURRENCY for the accepted set. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/**
 * Only USD is accepted until #1950 (packages/money FX/decimal-precision)
 * lands. Writing a non-USD amount into `billed_usd` at face value would be
 * silently wrong by the FX rate — reject rather than mis-record.
 */
const SUPPORTED_CURRENCY = 'USD';

const MAX_VENDOR_LENGTH = 128;
const MAX_CATEGORY_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface BilledRequestBody {
  vendor?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
  amountMinor?: unknown;
  currency?: unknown;
  category?: unknown;
  description?: unknown;
  source?: unknown;
  evidenceAssetId?: unknown;
}

interface ValidatedBilledBody {
  vendor: string;
  periodStart: Date;
  periodEnd: Date;
  amountMinor: number;
  currency: string;
  category: string | null;
  description: string | null;
  source: ManualBilledSource;
  evidenceAssetId: string | null;
}

function optionalString(value: unknown, field: string, maxLength?: number): { value: string | null } | { error: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  if (maxLength !== undefined && value.length > maxLength) {
    return { error: `${field} must be ${maxLength} characters or fewer` };
  }
  return { value };
}

function validateBilledBody(body: BilledRequestBody): { value: ValidatedBilledBody } | { error: string } {
  if (typeof body.vendor !== 'string' || !body.vendor.trim()) return { error: 'vendor is required' };
  if (body.vendor.trim().length > MAX_VENDOR_LENGTH) {
    return { error: `vendor must be ${MAX_VENDOR_LENGTH} characters or fewer` };
  }

  if (typeof body.currency !== 'string' || !CURRENCY_PATTERN.test(body.currency)) {
    return { error: 'currency must be a 3-letter uppercase ISO 4217 code (e.g. USD)' };
  }
  if (body.currency !== SUPPORTED_CURRENCY) {
    return { error: "currency must be 'USD' — other currencies are rejected until #1950 (packages/money FX) lands" };
  }

  if (typeof body.amountMinor !== 'number' || !Number.isInteger(body.amountMinor) || body.amountMinor < 0) {
    return { error: 'amountMinor must be an integer >= 0 (minor units)' };
  }

  if (typeof body.source !== 'string' || !VALID_SOURCES.has(body.source as ManualBilledSource)) {
    return { error: "source must be 'manual' or 'document'" };
  }

  if (typeof body.periodStart !== 'string' || typeof body.periodEnd !== 'string') {
    return { error: 'periodStart and periodEnd are required (ISO date/time strings)' };
  }

  const periodStart = new Date(body.periodStart);
  const periodEnd = new Date(body.periodEnd);
  if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
    return { error: 'periodStart and periodEnd must be valid dates' };
  }
  if (periodEnd < periodStart) {
    return { error: 'periodEnd must not be before periodStart' };
  }

  const category = optionalString(body.category, 'category', MAX_CATEGORY_LENGTH);
  if ('error' in category) return category;
  const description = optionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH);
  if ('error' in description) return description;
  const evidenceAssetId = optionalString(body.evidenceAssetId, 'evidenceAssetId');
  if ('error' in evidenceAssetId) return evidenceAssetId;

  // #1951 D3: the content-hash binding is the whole point of 'document' —
  // without an asset it is indistinguishable from a plain 'manual' entry.
  if (body.source === 'document' && !evidenceAssetId.value) {
    return { error: "evidenceAssetId is required when source is 'document'" };
  }

  return {
    value: {
      vendor: body.vendor.trim(),
      periodStart,
      periodEnd,
      amountMinor: body.amountMinor,
      currency: body.currency,
      category: category.value,
      description: description.value,
      source: body.source as ManualBilledSource,
      evidenceAssetId: evidenceAssetId.value,
    },
  };
}

/** Postgres unique-violation code — a second entry for the same (vendor, periodStart). */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const principalDid = resolveActingDid(authResult.identity);

  let body: BilledRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const validated = validateBilledBody(body ?? {});
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400, headers: cors });
  }

  try {
    const result = await insertManualBilledLine({ principalDid, ...validated.value });
    if ('error' in result) {
      const status = result.error === 'evidence_asset_not_found' ? 404 : 403;
      return NextResponse.json({ error: result.error }, { status, headers: cors });
    }
    return NextResponse.json(result, { status: 201, headers: cors });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: 'A usage.billed line item already exists for this vendor and period' },
        { status: 409, headers: cors },
      );
    }
    log.error({ err: String(err), principalDid }, 'manual usage.billed write failed');
    return NextResponse.json({ error: 'Failed to record usage.billed line item' }, { status: 500, headers: cors });
  }
}
