/**
 * POST /usage/api/receipts/extract (#1951 D4)
 *
 * Qwen-assist draft: LLM-extracts structured line items from an already-
 * uploaded receipt asset and returns them as an UNCONFIRMED draft. Owner-
 * only (the asset must belong to the resolved principal DID). This route
 * NEVER writes to `usage.billed` and NEVER mints an attestation — the
 * caller must review/edit the draft and POST it to `/usage/api/receipts`
 * to confirm and attest it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { extractReceiptDraft } from '@/src/lib/usage/billed/receipt-extract';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface ExtractRequestBody {
  assetId?: unknown;
}

const EXTRACT_ERROR_STATUS: Record<string, number> = {
  asset_not_found: 404,
  asset_not_owned: 403,
  unsupported_mime_type: 415,
  no_local_brain: 409,
  extraction_failed: 502,
};

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const ownerDid = resolveActingDid(authResult.identity);

  let body: ExtractRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  if (typeof body.assetId !== 'string' || !body.assetId.trim()) {
    return NextResponse.json({ error: 'assetId is required' }, { status: 400, headers: cors });
  }

  try {
    const result = await extractReceiptDraft({ ownerDid, assetId: body.assetId });
    if ('error' in result) {
      const status = EXTRACT_ERROR_STATUS[result.error] ?? 400;
      return NextResponse.json({ error: result.error }, { status, headers: cors });
    }
    return NextResponse.json(result, { status: 200, headers: cors });
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'receipt extraction route failed');
    return NextResponse.json({ error: 'Failed to extract receipt draft' }, { status: 500, headers: cors });
  }
}
