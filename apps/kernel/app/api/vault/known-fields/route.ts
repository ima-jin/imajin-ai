import { NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { KNOWN_VAULT_FIELDS } from '@/src/lib/vault/known-fields';

/**
 * GET /api/vault/known-fields (#2700) — the vault fields the kernel's own code
 * reads by a fixed name (`{ fields: [{ name, label, description, namespace }] }`),
 * so the /jin vault panel needs no field names at build time.
 *
 * Auth: `requireAdmin`, matching every other `/api/vault/**` route
 * (`list`, `set`, `rotate`, `mint/cards`, ...).
 *
 * Names and descriptions only — never values. Whether a field is stored or
 * missing is deliberately not worked out here; this stays a static, cheap read.
 */
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ fields: KNOWN_VAULT_FIELDS });
}
