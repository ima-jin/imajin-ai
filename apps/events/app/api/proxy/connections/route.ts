import { NextRequest, NextResponse } from 'next/server';

const CONNECTIONS_SERVICE_URL = process.env.CONNECTIONS_SERVICE_URL || 'http://localhost:3003';

export async function GET(request: NextRequest) {
  try {
    const cookie = request.headers.get('cookie') || '';
    const res = await fetch(`${CONNECTIONS_SERVICE_URL}/api/connections`, {
      headers: { cookie },
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json({ connections: [] }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch connections' }, { status: 502 });
  }
}
