/**
 * Shared DB accessor for the match module.
 * Dynamic import defers DB connection until first use (same pattern as config.ts).
 */
export async function getMatchDb() {
  const { getClient } = await import('@imajin/db');
  return getClient();
}
