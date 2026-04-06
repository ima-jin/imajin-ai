// Removed as part of #435 (v1→v2 migration). V1 participants table is gone.
import { NextRequest, NextResponse } from 'next/server';

export function GET(_req: NextRequest) {
  return NextResponse.json({ error: 'This endpoint has been removed' }, { status: 410 });
}
