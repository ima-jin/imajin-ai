/**
 * Simple ID generator using prefix + random string
 */
export function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}
