import { NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { vaultService } from '@/src/lib/vault';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

export async function GET() {
  try {
    const entries = await vaultService.list();

    const results = entries.map((entry) => ({
      field: entry.field,
      hint: entry.encrypted.slice(0, 4),
      cid: entry.cid,
      senderDid: entry.senderDid,
      timestamp: entry.timestamp,
      status: entry.deleted === true ? 'deleted' : 'active',
    }));

    return NextResponse.json(results);
  } catch (error) {
    log.error({ err: String(error) }, 'Vault list error');
    return toVaultErrorResponse(error, 'Failed to list vault entries', 500);
  }
}
