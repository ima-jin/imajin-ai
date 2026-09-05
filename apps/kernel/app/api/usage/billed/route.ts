/**
 * POST /api/usage/billed (#2030)
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

const VALID_SOURCES: readonly ManualBilledSource[] = ['manual', 'document'];

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

function optionalString(value: unknown): { value: string | null } | { error: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { error: 'must be a string' };
  return { value };
}

function validateBilledBody(body: BilledRequestBody): { value: ValidatedBilledBody } | { error: string } {
  if (typeof body.vendor !== 'string' || !body.vendor.trim()) return { error: 'vendor is required' };
  if (typeof body.currency !== 'string' || !body.currency.trim()) return { error: 'currency is required' };
  if (typeof body.amountMinor !== 'number' || !Number.isInteger(body.amountMinor)) {
    return { error: 'amountMinor must be an integer (minor units)' };
  }
  if (typeof body.source !== 'string' || !VALID_SOURCES.includes(body.source as ManualBilledSource)) {
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

  const category = optionalString(body.category);
  if ('error' in category) return { error: `category ${category.error}` };
  const description = optionalString(body.description);
  if ('error' in description) return { error: `description ${description.error}` };
  const evidenceAssetId = optionalString(body.evidenceAssetId);
  if ('error' in evidenceAssetId) return { error: `evidenceAssetId ${evidenceAssetId.error}` };

  return {
    value: {
      vendor: body.vendor.trim(),
      periodStart,
      periodEnd,
      amountMinor: body.amountMinor,
      currency: body.currency.trim(),
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
