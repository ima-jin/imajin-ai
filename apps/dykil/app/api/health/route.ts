import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'dykil',
    timestamp: new Date().toISOString(),
  });
}
