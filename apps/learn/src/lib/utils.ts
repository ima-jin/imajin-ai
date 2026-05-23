/**
 * Generate a random ID with prefix
 */
export function generateId(prefix: string): string {
  const random = crypto.randomUUID().replaceAll('-', '').substring(0, 13);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Generate URL-friendly slug from title
 */
export function slugify(text: string): string {
  let out = '';
  let previousDash = false;
  for (const ch of text.toLowerCase()) {
    const code = ch.charCodeAt(0);
    const isAlphaNum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (isAlphaNum) {
      out += ch;
      previousDash = false;
      continue;
    }
    const isSeparator = ch === ' ' || ch === '\t' || ch === '\n' || ch === '_' || ch === '-';
    if (isSeparator && !previousDash) {
      out += '-';
      previousDash = true;
    }
  }

  let start = 0;
  let end = out.length;
  while (start < end && out[start] === '-') start += 1;
  while (end > start && out[end - 1] === '-') end -= 1;

  return out.slice(start, Math.min(end, start + 80));
}

/**
 * Format cents to dollars
 */
export function formatMoney(cents: number, currency = 'CAD'): string {
  return new Intl.NumberFormat('en-CA', {
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
