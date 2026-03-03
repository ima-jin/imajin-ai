import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

/**
 * CORS headers for cross-origin requests from *.imajin.ai
 */
export function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '';
  const allowed = origin.endsWith('.imajin.ai') || origin === 'https://imajin.ai';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function corsOptions(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * Generate a prefixed ID
 */
export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * Standard JSON response
 */
export function jsonResponse<T>(data: T, status = 200, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(data, { status, headers });
}

/**
 * Standard error response
 */
export function errorResponse(message: string, status = 400, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: message }, { status, headers });
}

/**
 * Validate DID format
 */
export function isValidDid(did: string): boolean {
  return /^did:imajin:[a-zA-Z0-9]+$/.test(did);
}

/**
 * Check if user has required role
 */
export function hasRole(userRole: string, requiredRole: string): boolean {
  const hierarchy = ['readonly', 'member', 'admin', 'owner'];
  const userLevel = hierarchy.indexOf(userRole);
  const requiredLevel = hierarchy.indexOf(requiredRole);
  return userLevel >= requiredLevel;
}

/**
 * Format timestamp for display
 */
export function formatTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
