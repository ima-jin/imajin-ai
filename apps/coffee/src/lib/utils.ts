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
 * Format cents to dollars
 */
export function formatMoney(cents: number, currency = 'USD'): string {
  if (currency === 'SOL') {
    return `${(cents / 1_000_000_000).toFixed(4)} SOL`;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100);
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
