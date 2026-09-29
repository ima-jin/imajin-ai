import { NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { KNOWN_VAULT_FIELDS } from '@/src/lib/vault/known-fields';

/**
 * GET /api/vault/known-fields (#2445 defect 4) — the fields the kernel's
 * own code reads by a fixed name, for the admin vault panel's add-dialog
 * suggestions and "missing" table rows. Presence (is it actually sealed?)
 * is deliberately NOT computed here — the panel already has the real list
 * from `GET /api/vault/list` and cross-references it client-side, so this
 * route stays a static, cheap read with nothing to get out of sync.
 */
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ fields: KNOWN_VAULT_FIELDS });
}
