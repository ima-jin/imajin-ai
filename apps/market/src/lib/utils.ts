/**
 * Generate a random ID with prefix
 */
export function generateId(prefix: string): string {
  const random = crypto.randomUUID().replace(/-/g, '').substring(0, 13);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
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

/**
 * ISO 4217 currencies stored as whole units (not cents)
 */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'BIF', 'DJF', 'GNF', 'ISK',
  'KMF', 'PYG', 'RWF', 'UGX', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase());
}

/**
 * Format price amount to human-readable string.
 * For non-zero-decimal currencies, amount is in smallest unit (e.g. cents).
 * For zero-decimal currencies, amount is the whole unit.
 */
export function formatPrice(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const value = isZeroDecimal(code) ? amount : amount / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
  }).format(value);
}
