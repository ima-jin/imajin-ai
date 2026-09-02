/**
 * Shared spend-cap settings route factory (#1923, Phase 3 of #1922).
 *
 * Every brain connector (Gemini, Anthropic, xAI, OpenAI, Moonshot) needs a
 * byte-identical `GET`/`PUT`/`DELETE` handler for its declared spend cap —
 * the same move `createConnectorTokenRoutes` (seal/unseal) and the `warp`
 * connector's environment-setting route already made for their own
 * single-field settings. Declaring it once here is what keeps the Nth
 * connector's spend-cap route a one-line re-export rather than a clone.
 *
 * Renders through the EXISTING generic `ConnectorSettingsUi` /
 * `ConnectorSettingsSection` component (#1632) — no new UI code. The field
 * is a single compact string, `"<amountUsd>:<period>"` (e.g. `"50:daily"`),
 * because that component's DELETE semantics clear exactly one field with no
 * body (see `ConnectorSettingsSection.save()`), which only composes cleanly
 * with a single-field settings section, matching the `warp` precedent.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import { readConnectorRegistration, setConnectorSpendCap } from '@/src/lib/kernel/connector-registry-store';
import { parseSpendCap, serializeSpendCap, type SpendCap, type SpendCapPeriod } from '@/src/lib/inference/spend-cap';

const log = createLogger('kernel');

const VALID_PERIODS: ReadonlySet<SpendCapPeriod> = new Set(['daily', 'monthly', 'total']);

/** Format a cap back into the `"<amountUsd>:<period>"` field value. */
function formatSpendCap(cap: SpendCap): string {
  return `${cap.amountUsd}:${cap.period}`;
}

/** Parse the `"<amountUsd>:<period>"` field value, or `undefined` when malformed. */
function parseSpendCapField(value: string): SpendCap | undefined {
  const [amountRaw, periodRaw] = value.split(':').map((part) => part.trim());
  const amountUsd = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amountUsd) || amountUsd <= 0) return undefined;
  if (!periodRaw || !VALID_PERIODS.has(periodRaw as SpendCapPeriod)) return undefined;
  return { amountUsd, period: periodRaw as SpendCapPeriod };
}

type RouteHandler = (request: NextRequest) => Promise<NextResponse>;

export interface ConnectorSpendCapRouteHandlers {
  GET: RouteHandler;
  PUT: RouteHandler;
  DELETE: RouteHandler;
  OPTIONS: RouteHandler;
}

/** Identical across every connector — declared once at module scope rather than recreated per factory call. */
async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return corsOptions(request) as NextResponse;
}

/**
 * Build the four handlers for one connector's spend-cap settings endpoint.
 * Designed to be re-exported straight from the connector's route file:
 *
 * ```ts
 * export const { GET, PUT, DELETE, OPTIONS } = createConnectorSpendCapRoute('xai');
 * ```
 */
export function createConnectorSpendCapRoute(provider: string): ConnectorSpendCapRouteHandlers {
  /** Returns `{ spendCap: "<amountUsd>:<period>" | "" }` for the settings-section GET. */
  async function GET(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);
    const auth = await resolveConnectorOwnerDid(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }

    const registration = await readConnectorRegistration(auth.ownerDid, provider);
    const cap = parseSpendCap(registration?.spendCap);
    return NextResponse.json({ spendCap: cap ? formatSpendCap(cap) : '' }, { headers: cors });
  }

  /** Sets the spend cap from `{ spendCap: "<amountUsd>:<period>" }`. */
  async function PUT(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);
    const auth = await resolveConnectorOwnerDid(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }

    let body: { spendCap?: unknown };
    try {
      body = (await request.json()) as { spendCap?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
    }

    if (typeof body.spendCap !== 'string') {
      return NextResponse.json({ error: 'spendCap must be a string' }, { status: 400, headers: cors });
    }
    const cap = parseSpendCapField(body.spendCap);
    if (!cap) {
      return NextResponse.json(
        { error: 'spendCap must be formatted as "<amountUsd>:<daily|monthly|total>", e.g. "50:daily"' },
        { status: 400, headers: cors },
      );
    }

    try {
      await setConnectorSpendCap(auth.ownerDid, provider, serializeSpendCap(cap));
    } catch (err) {
      log.error({ err: String(err), ownerDid: auth.ownerDid, provider }, 'spend cap: failed to save');
      return NextResponse.json({ error: 'Failed to save spend cap' }, { status: 500, headers: cors });
    }

    return NextResponse.json({ spendCap: formatSpendCap(cap) }, { headers: cors });
  }

  /** Clears the spend cap (no limit). */
  async function DELETE(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);
    const auth = await resolveConnectorOwnerDid(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }

    try {
      await setConnectorSpendCap(auth.ownerDid, provider, null);
    } catch (err) {
      log.error({ err: String(err), ownerDid: auth.ownerDid, provider }, 'spend cap: failed to clear');
      return NextResponse.json({ error: 'Failed to clear spend cap' }, { status: 500, headers: cors });
    }

    return NextResponse.json({ spendCap: '' }, { headers: cors });
  }

  return { GET, PUT, DELETE, OPTIONS };
}
