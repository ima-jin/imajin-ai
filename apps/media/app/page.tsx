import { redirect } from "next/navigation";
import { getSession } from "@/src/lib/auth";
import { MediaManager } from "@/src/components/MediaManager";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getSession();

  if (!session) {
    const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || process.env.AUTH_SERVICE_URL || "";
    const loginUrl = authUrl ? `${authUrl}/login` : "/api/auth/login";
    redirect(loginUrl);
  }

  return <MediaManager session={session} />;
}
