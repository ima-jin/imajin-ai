import { NextRequest, NextResponse } from 'next/server';
import { vaultService } from '@/src/lib/vault';

export async function GET(
  _request: NextRequest,
  { params }: { params: { field: string } }
) {
  const { field } = params;

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
    return NextResponse.json({ error: 'Failed to retrieve history' }, { status: 500 });
  }
}
