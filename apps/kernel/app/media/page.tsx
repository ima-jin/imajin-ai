import { redirect } from "next/navigation";
import { getSession, resolveActingDid } from "@imajin/auth";
import { MediaPageClient } from "@/src/components/media/MediaPageClient";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getSession({ service: "media" });

  if (!session) {
    redirect("/auth/login");
  }

  return <MediaPageClient session={{ ...session, id: resolveActingDid(session) }} />;
}
