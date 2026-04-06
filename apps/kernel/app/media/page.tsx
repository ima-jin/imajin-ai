import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSessionFromCookies } from "@/src/lib/kernel/session";
import type { Identity } from "@imajin/auth";
import { MediaPageClient } from "@/src/components/media/MediaPageClient";

export const dynamic = "force-dynamic";

export default async function Page() {
  const cookieStore = await cookies();
  const session = await getSessionFromCookies(cookieStore.toString());

  if (!session) {
    redirect("/auth/login");
  }

  const identity: Identity = {
    id: session.did,
    type: session.type as Identity["type"],
    name: session.name,
    handle: session.handle,
    tier: session.tier as Identity["tier"],
    chainVerified: session.chainVerified,
  };

  return <MediaPageClient session={identity} />;
}
