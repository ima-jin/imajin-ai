import type { Identity } from "./types";
import { requireAuth } from "./require-auth";

/**
 * Optional auth — returns identity if present, null otherwise.
 */
export async function optionalAuth(request: Request): Promise<Identity | null> {
  const result = await requireAuth(request);
  if ("error" in result) return null;
  return result.identity;
}
