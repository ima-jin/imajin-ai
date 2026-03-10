import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, corsOptions, buildServiceUrlMap, getService } from "@imajin/config";

const IS_PROD = process.env.NODE_ENV === "production" || process.env.IMAJIN_ENV === "prod";
const SERVICE_URLS = buildServiceUrlMap(process.env as Record<string, string | undefined>, IS_PROD ? "prod" : "dev");

// Override registry's own URL to use localhost + current port
SERVICE_URLS["registry"] = "http://localhost:" + (process.env.PORT || "3002");

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: { service: string } }
) {
  const cors = corsHeaders(request);
  const { service } = params;

  if (!getService(service)) {
    return NextResponse.json({ error: "Unknown service" }, { status: 404, headers: cors });
  }

  const internalUrl = SERVICE_URLS[service];

  try {
    const res = await fetch(`${internalUrl}/api/spec`, {
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Service ${service} returned ${res.status}` },
        { status: 502, headers: cors }
      );
    }

    const text = await res.text();
    const contentType = res.headers.get("content-type") || "";

    return new NextResponse(text, {
      headers: {
        ...cors,
        "Content-Type": contentType || "text/plain",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach ${service} service` },
      { status: 502, headers: cors }
    );
  }
}
