/**
 * Generate a random ID with prefix
 */
export function generateId(prefix: string): string {
  const random = Math.random().toString(36).substring(2, 15);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Validate handle format (lowercase, alphanumeric, underscores, 3-30 chars)
 */
export function isValidHandle(handle: string): boolean {
  return /^[a-z0-9_]{3,30}$/.test(handle);
}

/**
 * Base58 encoding for DIDs
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  let encoded = '';

  while (num > 0n) {
    const remainder = Number(num % 61n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    num = num / 61n;
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

/**
 * Standard JSON response helpers
 */
export function jsonResponse(data: any, status = 200) {
  return Response.json(data, { status });
}

export function errorResponse(error: string, status = 400) {
  return Response.json({ error }, { status });
}
