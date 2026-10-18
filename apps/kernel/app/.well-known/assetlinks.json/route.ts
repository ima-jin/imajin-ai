import { NextResponse } from "next/server";
import { operationalAppOrigins } from "@/src/lib/kernel/operational-apps";

export const dynamic = "force-dynamic";

/** Android association discovery for the kernel and active registered destinations. */
export async function GET() {
  const origins = await operationalAppOrigins();
  const assetLinks = origins.map((site) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "web", site },
  }));

  return NextResponse.json(assetLinks, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "application/json",
    },
  });
}
