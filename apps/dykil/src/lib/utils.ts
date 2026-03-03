import { NextRequest, NextResponse } from 'next/server';

/**
 * CORS headers for cross-origin requests from *.imajin.ai
 */
export function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '';
  const allowed = origin.endsWith('.imajin.ai') || origin === 'https://imajin.ai';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function corsOptions(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export function jsonResponse(data: any, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(data, { status, headers });
}

export function errorResponse(message: string, status = 400, headers?: Record<string, string>) {
  return NextResponse.json({ error: message }, { status, headers });
}

export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}
