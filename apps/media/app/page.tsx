import { redirect } from "next/navigation";
import { getSession } from "@/src/lib/auth";
import { MediaManager } from "@/src/components/MediaManager";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getSession();

  if (!session) {
    const loginUrl = process.env.AUTH_SERVICE_URL
      ? `${process.env.AUTH_SERVICE_URL}/login`
      : "/api/auth/login";
    redirect(loginUrl);
  }

  return <MediaManager session={session} />;
}
