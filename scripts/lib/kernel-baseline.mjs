import { createHash } from 'node:crypto';

export function migrationChecksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** Never infer adoption from a single sentinel: partial histories must stop. */
export function baselineAction(manifest, applied, hash, occupied) {
  const existing = applied.get(manifest.filename);
  if (existing) {
    if (existing !== hash) throw new Error('Kernel baseline checksum mismatch; refusing modified baseline');
    return 'skip';
  }
  const historical = manifest.migrations.filter(entry => applied.has(entry.filename));
  if (historical.length > 0) {
    const missing = manifest.migrations.filter(entry => !applied.has(entry.filename));
    if (missing.length > 0) {
      throw new Error(`Incomplete pre-baseline ledger; apply missing history first: ${missing.map(entry => entry.filename).join(', ')}`);
    }
    const changed = manifest.migrations.filter(entry => applied.get(entry.filename) !== entry.checksum);
    if (changed.length > 0) {
      throw new Error(`Historical checksum mismatch: ${changed.map(entry => entry.filename).join(', ')}`);
    }
    if (!occupied) throw new Error('Historical ledger exists without kernel schema; refusing adoption');
    return 'adopt';
  }
  if (occupied || applied.size > 0) {
    throw new Error('Untracked existing database; restore/verify historical ledger before re-baselining');
  }
  return 'apply';
}

export async function prepareKernelBaseline(sql, manifest, content) {
  const hash = migrationChecksum(content);
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(2525, 1991)`;
    await tx`LOCK TABLE public._migrations IN EXCLUSIVE MODE`;
    const rows = await tx`SELECT filename, checksum FROM public._migrations`;
    const occupied = await tx`
      SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ANY(${manifest.schemas})) AS present
    `;
    const action = baselineAction(manifest, new Map(rows.map(row => [row.filename, row.checksum])), hash, occupied[0].present);
    if (action === 'skip') return;
    if (action === 'apply') await tx.unsafe(content);
    await tx`
      INSERT INTO public._migrations (filename, checksum) VALUES (${manifest.filename}, ${hash})
    `;
    console.log(`Kernel baseline: ${action === 'adopt' ? 'marked applied (no DDL)' : 'initialized fresh kernel'}`);
  });
}
