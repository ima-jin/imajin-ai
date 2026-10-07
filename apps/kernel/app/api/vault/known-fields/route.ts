import { NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@imajin/auth';
import { KNOWN_VAULT_FIELDS } from '@/src/lib/vault/known-fields';

/**
 * GET /api/vault/known-fields (#2700) — the vault fields the kernel's own code
 * reads by a fixed name (`{ fields: [{ name, label, description, namespace }] }`),
 * so the /jin vault panel needs no field names at build time.
 *
 * Names and descriptions only — never values. Whether a field is actually
 * sealed is deliberately not computed here; the panel cross-references the
 * real vault listing client-side, so this stays a static, cheap read.
 */
export async function GET(request: Request) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  return NextResponse.json({ fields: KNOWN_VAULT_FIELDS });
}
