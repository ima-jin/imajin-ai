import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { vaultService } from '@/src/lib/vault';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';
import { parseVaultFieldName } from '@/src/lib/vault/field-grammar';

const log = createLogger('kernel');

export async function GET(_request: NextRequest, props: { params: Promise<{ field: string }> }) {
  const params = await props.params;
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsedField = parseVaultFieldName(params.field);
  if (!parsedField.ok) {
    return NextResponse.json({ error: parsedField.message }, { status: 400 });
  }
  const field = parsedField.value.field;

  try {
    const history = await vaultService.getHistory(field);

    const chain = history.map((entry) => ({
      cid: entry.cid,
      previousCid: entry.previousCid ?? null,
      senderDid: entry.senderDid,
      timestamp: entry.timestamp,
    }));

    return NextResponse.json({ field, chain });
  } catch (error) {
    log.error({ err: String(error), field }, 'Vault history error');
    return toVaultErrorResponse(error, 'Failed to retrieve history', 500);
  }
}
