import { NextRequest, NextResponse } from 'next/server';
export { corsHeaders, corsOptions } from '@imajin/config';

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
