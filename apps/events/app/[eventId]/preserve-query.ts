/**
 * Build a query string from Next.js searchParams, preserving all values.
 * Returns '' if no params, or '?key=val&...' if present.
 */
export function buildQueryString(
  sp: Record<string, string | string[] | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') {
      qs.set(key, value);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        qs.append(key, v);
      }
    }
  }
  const str = qs.toString();
  return str ? `?${str}` : '';
}
