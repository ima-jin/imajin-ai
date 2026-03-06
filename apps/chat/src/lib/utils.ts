import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
export { corsHeaders, corsOptions } from '@imajin/config';

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
