export {
  requireAuth,
  optionalAuth,
  getSession,
  requireHardDID,
} from "@imajin/auth";
export type { Identity, AuthResult, AuthError } from "@imajin/auth";

/**
 * @deprecated Use optionalAuth(request) instead
 */
export async function getSessionFromCookie(
  cookieHeader: string | null
): Promise<import("@imajin/auth").Identity | null> {
  const { optionalAuth: opt } = await import("@imajin/auth");
  const fakeRequest = new Request("http://localhost", {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
  return opt(fakeRequest);
}
