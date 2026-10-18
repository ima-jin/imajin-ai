import { NextResponse } from "next/server";
import { operationalAppOrigins } from "@/src/lib/kernel/operational-apps";

export const dynamic = "force-dynamic";

/** iOS association discovery for the kernel and active registered destinations. */
export async function GET() {
  const origins = await operationalAppOrigins();
  const association = {
    webcredentials: { apps: [] },
    applinks: {
      apps: [],
      details: origins.map((origin) => ({
        appID: `*.${new URL(origin).hostname}`,
        paths: ["*"],
        components: [{ "/": "/*", comment: new URL(origin).host }],
      })),
    },
  };

  return NextResponse.json(association, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "application/json",
    },
  });
}
