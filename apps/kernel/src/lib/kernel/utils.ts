import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

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
 * Validate handle format (lowercase, alphanumeric, underscores, 3-30 chars)
 */
export function isValidHandle(handle: string): boolean {
  return /^[a-z0-9_]{3,30}$/.test(handle);
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

/**
 * Base58 encoding for DIDs
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  let encoded = '';

  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    num = num / 58n;
  }

  // Add leading '1's for leading zero bytes
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    encoded = '1' + encoded;
  }

  return encoded || '1';
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
