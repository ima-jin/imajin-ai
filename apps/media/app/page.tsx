import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/src/lib/auth";
import { MediaPageClient } from "@/src/components/MediaPageClient";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getSession();

  if (!session) {
    const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || process.env.AUTH_SERVICE_URL || "";
    const headersList = await headers();
    const host = headersList.get("x-forwarded-host") || headersList.get("host") || "";
    const proto = headersList.get("x-forwarded-proto") || "https";
    const currentUrl = host ? `${proto}://${host}` : "";
    const next = currentUrl ? `?next=${encodeURIComponent(currentUrl)}` : "";
    const loginUrl = authUrl ? `${authUrl}/login${next}` : "/api/auth/login";
    redirect(loginUrl);
  }

  return <MediaPageClient session={session} />;
}
