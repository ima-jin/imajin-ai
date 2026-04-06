import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'profile',
    timestamp: new Date().toISOString(),
  });
}
