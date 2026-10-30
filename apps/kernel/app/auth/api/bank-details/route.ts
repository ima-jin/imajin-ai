import { NextRequest, NextResponse } from 'next/server';
import { requireDocumentActor } from '@/src/lib/auth/document-authorization';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { readBankDetails, saveBankDetails, deleteBankDetails } from '@/src/lib/vault/bank-details';
import { BANK_RAILS, BankDetailsValidationError } from '@/src/lib/vault/bank-details-schema';

export const dynamic = 'force-dynamic';
export function OPTIONS(request: NextRequest) { return corsOptions(request); }

/** No caching, values in diagnostics, app/service tokens, or caller-selected DID. */
async function handle(request: NextRequest, operation: 'read' | 'save' | 'delete') {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const actor = await requireDocumentActor(request, { write: true });
  if (actor instanceof NextResponse) return actor;
  try {
    if (operation === 'read') {
      const record = await readBankDetails(actor.effectiveDid);
      if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404, headers });
      const { hasRail, ...fields } = record;
      return NextResponse.json({ ...fields, hasRail: Object.fromEntries(BANK_RAILS.map(rail => [rail, hasRail(rail)])) }, { headers });
    }
    if (operation === 'delete') {
      const deleted = await deleteBankDetails(actor);
      return NextResponse.json(deleted ? { ok: true } : { error: 'Not found' }, { status: deleted ? 200 : 404, headers });
    }
    let raw: unknown;
    try { raw = await request.json(); }
    catch { return NextResponse.json({ error: 'Invalid JSON body', field: 'body' }, { status: 400, headers }); }
    return NextResponse.json(await saveBankDetails(actor, raw), { status: 201, headers });
  } catch (error) {
    if (error instanceof BankDetailsValidationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400, headers });
    }
    // Do not serialize/log errors: drivers may embed SQL parameters or secret input.
    return NextResponse.json({ error: 'Bank details unavailable' }, { status: 503, headers });
  }
}

export function GET(request: NextRequest) { return handle(request, 'read'); }
export function PUT(request: NextRequest) { return handle(request, 'save'); }
export function DELETE(request: NextRequest) { return handle(request, 'delete'); }
