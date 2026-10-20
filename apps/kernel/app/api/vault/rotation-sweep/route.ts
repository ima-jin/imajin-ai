import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { loadAndUnseal, sealAndStoreV2 } from '@/src/lib/vault';
import { db, vaultDelegationGrants } from '@/src/db';
import {
  exportRotationHandoff, isSweepField, reimportRotationHandoff,
  rotationHandoffStatus, validateRotationRecipient,
} from '@/src/lib/vault/rotation-handoff';
import { parseVaultFieldName } from '@/src/lib/vault/field-grammar';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Only public metadata is returned; plaintext never crosses HTTP or a log edge. */
export async function GET() {
  if (!(await requireAdmin())) return json({ error: 'Unauthorized' }, 401);
  try {
    return json(await rotationHandoffStatus());
  } catch {
    return json({ error: 'Rotation handoff unavailable; inspect storage status without revealing contents' }, 409);
  }
}
async function restoreField(field: string, plaintext: string) {
  // A retry must not create another Tier 1 request for a field whose grant
  // has already arrived. Old-key unreadability on the first attempt is expected.
  try {
    if (await loadAndUnseal(field) === plaintext) return;
  } catch {
    // Retain the encrypted handoff until a new-key readback succeeds below.
  }
  await sealAndStoreV2(field, plaintext);
  if (await loadAndUnseal(field) !== plaintext) throw new Error('Reimport readback failed');
}

async function collectFields() {
  const rows = await db.selectDistinct({ field: vaultDelegationGrants.field })
    .from(vaultDelegationGrants).where(eq(vaultDelegationGrants.status, 'active'));
  const exported: { field: string; plaintext: string }[] = [];
  for (const { field } of rows) {
    if (!parseVaultFieldName(field).ok) throw new Error('Invalid active grant field');
    if (!isSweepField(field)) continue;
    const plaintext = await loadAndUnseal(field);
    // Stale active grants are an error, not a misleadingly successful short export.
    if (plaintext === undefined) throw new Error('Active grant is unreadable');
    exported.push({ field, plaintext });
  }
  return exported;
}

/** Browser-session admin flow. Legacy plaintext bodies are deliberately refused. */
export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) return json({ error: 'Unauthorized' }, 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid phase' }, 400);
  const input = body as Record<string, unknown>;
  if ('fields' in input) return json({ error: 'Plaintext rotation transport is forbidden' }, 403);
  if (input.phase !== 'export' && input.phase !== 'reimport') return json({ error: 'Invalid phase' }, 400);
  const allowed = input.phase === 'export' ? ['phase', 'newPublicKey'] : ['phase'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return json({ error: 'Unexpected rotation input' }, 400);
  if (input.phase === 'export') {
    try {
      validateRotationRecipient(input.newPublicKey);
    } catch {
      return json({ error: 'A valid new Ed25519 public key is required' }, 400);
    }
  }
  try {
    return json(input.phase === 'export'
      ? await exportRotationHandoff(input.newPublicKey as string, collectFields)
      : await reimportRotationHandoff(restoreField));
  } catch {
    // Do not serialize upstream exceptions: vault/filesystem errors can contain
    // private material. Failure leaves encrypted recovery state in place.
    return json({ error: 'Rotation sweep failed; retain the old key and sealed handoff, and investigate server-side' }, 409);
  }
}
