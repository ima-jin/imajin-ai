import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'chat',
    timestamp: new Date().toISOString(),
  });
}
