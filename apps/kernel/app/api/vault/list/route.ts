import { NextResponse } from 'next/server';
import { vaultService } from '@/src/lib/vault';

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
    return NextResponse.json({ error: 'Failed to list vault entries' }, { status: 500 });
  }
}
