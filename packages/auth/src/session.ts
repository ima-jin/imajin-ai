import { SESSION_COOKIE_NAME } from "@imajin/config";
import type { Identity } from "./types";

const getAuthUrl = () => process.env.AUTH_SERVICE_URL!;

/**
 * Get session for server components (reads from Next.js cookie store).
 *
 * Use in server components and server actions — NOT in API routes
 * (use requireAuth there instead).
 */
export async function getSession(): Promise<Identity | null> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);

  if (!sessionCookie) return null;

  try {
    const response = await fetch(`${getAuthUrl()}/api/session`, {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie.value}`,
      },
      cache: "no-store",
    });

    if (!response.ok) return null;

    const data = await response.json();
    const actingAs = cookieStore.get("x-acting-as")?.value;
    return {
      id: data.did,
      type: data.type || "human",
      name: data.name,
      handle: data.handle,
      tier: data.tier || "soft",
      actingAs: actingAs || undefined,
    };
  } catch (error) {
    console.error("[AUTH] Session fetch failed:", error);
    return null;
  }
}
