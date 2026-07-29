import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { loadAndUnseal, sealAndStoreV2 } from '@/src/lib/vault';
import { db, vaultDelegationGrants } from '@/src/db';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

type ExportBody = { phase: 'export' };
type ReimportBody = {
  phase: 'reimport';
  fields: { field: string; plaintext: string }[];
};
type RotationSweepBody = ExportBody | ReimportBody;

/**
 * POST /api/vault/rotation-sweep — re-seal all delegation-grant fields after AUTH_PRIVATE_KEY rotation.
 *
 * Admin-only.  No plaintext is logged or persisted at any point in this handler.
 *
 * ## Two-phase protocol
 *
 * ### Phase A — export (call with OLD key still loaded)
 * ```
 * POST /api/vault/rotation-sweep
 * { "phase": "export" }
 * → { "fields": [{ "field": "GH_TOKEN", "plaintext": "..." }, ...] }
 * ```
 * Returns all delegation-grant field names with their unsealed plaintexts.
 * The caller must store these in memory (never on disk) until Phase B completes.
 *
 * ### Phase B — reimport (call after NEW AUTH_PRIVATE_KEY is loaded and process restarted)
 * ```
 * POST /api/vault/rotation-sweep
 * { "phase": "reimport", "fields": [{ "field": "GH_TOKEN", "plaintext": "..." }] }
 * → { "resealed": 1 }
 * ```
 * Re-seals each field with the new keys.  sealAndStoreV2 supersedes the old grant
 * automatically.  Fails loudly (500) if any single field fails — never silently skips.
 *
 * ### Crash recovery
 * If the process crashes between phases, re-run Phase B (sealAndStoreV2 is idempotent
 * per field — it supersedes previous grants and writes a new vault entry).
 */
export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: RotationSweepBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || !('phase' in body)) {
    return NextResponse.json({ error: "phase is required ('export' or 'reimport')" }, { status: 400 });
  }

  if (body.phase === 'export') {
    return handleExport();
  }

  if (body.phase === 'reimport') {
    const fields = (body as ReimportBody).fields;
    if (!Array.isArray(fields)) {
      return NextResponse.json({ error: 'fields must be an array' }, { status: 400 });
    }
    return handleReimport(fields);
  }

  return NextResponse.json(
    { error: "phase must be 'export' or 'reimport'" },
    { status: 400 },
  );
}

/**
 * Phase A: unseal every active delegation-grant field with the current (old) keys.
 *
 * SECURITY: The response body contains plaintext secrets.
 * Call this endpoint only over a trusted transport.  The response is never logged.
 */
async function handleExport(): Promise<NextResponse> {
  try {
    // Collect all distinct field names that have an active delegation grant.
    const rows = await db
      .selectDistinct({ field: vaultDelegationGrants.field })
      .from(vaultDelegationGrants)
      .where(eq(vaultDelegationGrants.status, 'active'));

    const exported: { field: string; plaintext: string }[] = [];

    for (const { field } of rows) {
      let plaintext: string | undefined;
      try {
        plaintext = await loadAndUnseal(field);
      } catch (err) {
        // A field that cannot be unsealed (e.g. vault entry missing or corrupted)
        // is a hard error — abort the sweep so the operator is aware.
        log.error({ err: String(err), field }, 'Rotation sweep export: loadAndUnseal failed');
        return NextResponse.json(
          { error: `Failed to unseal field '${field}' — aborting sweep`, field },
          { status: 500 },
        );
      }

      if (plaintext === undefined) {
        // Entry exists as an active grant in the DB but not in the vault file.
        // Log a warning and skip rather than hard-failing: the grant row is stale.
        log.error({ field }, 'Rotation sweep export: field has active grant but no vault entry — skipping');
        continue;
      }

      exported.push({ field, plaintext });
    }

    // NOTE: plaintext values are intentionally in the response.
    // This is by design (admin-only, key-rotation operator flow) and is documented.
    return NextResponse.json({ fields: exported });
  } catch (error) {
    log.error({ err: String(error) }, 'Rotation sweep export failed');
    return toVaultErrorResponse(error, 'Rotation sweep export failed', 500);
  }
}

/**
 * Phase B: re-seal each field with the new (current) keys.
 *
 * sealAndStoreV2 supersedes the old delegation grant and writes a new vault entry,
 * making the field readable with the new AUTH_PRIVATE_KEY-derived X25519 keypair.
 * Fails loudly if any field fails — never silently skips.
 */
async function handleReimport(
  fields: { field: string; plaintext: string }[],
): Promise<NextResponse> {
  if (fields.length === 0) {
    return NextResponse.json({ resealed: 0 });
  }

  try {
    for (const { field, plaintext } of fields) {
      if (typeof field !== 'string' || field.trim().length === 0) {
        return NextResponse.json({ error: 'Each entry must have a non-empty field name' }, { status: 400 });
      }
      if (typeof plaintext !== 'string') {
        return NextResponse.json({ error: `plaintext for field '${field}' must be a string` }, { status: 400 });
      }

      try {
        await sealAndStoreV2(field.trim(), plaintext);
      } catch (err) {
        // Fail loudly — do not silently skip.  The operator must re-run with the
        // full field list once the underlying issue is resolved.
        log.error({ err: String(err), field }, 'Rotation sweep reimport: sealAndStoreV2 failed');
        return toVaultErrorResponse(err, `Failed to re-seal field '${field}' — aborting sweep`, 500);
      }
    }

    log.info({ resealed: fields.length }, 'Vault rotation sweep reimport complete');
    return NextResponse.json({ resealed: fields.length });
  } catch (error) {
    log.error({ err: String(error) }, 'Rotation sweep reimport failed');
    return toVaultErrorResponse(error, 'Rotation sweep reimport failed', 500);
  }
}
