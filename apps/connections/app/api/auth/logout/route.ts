import { NextRequest, NextResponse } from 'next/server';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export async function POST(request: NextRequest) {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/api/logout`, {
      method: 'POST',
      headers: { Cookie: request.headers.get('cookie') || '' },
    });
    const headers = new Headers();
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) headers.set('set-cookie', setCookie);
    return NextResponse.json({ ok: true }, { headers });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 502 });
  }
}
