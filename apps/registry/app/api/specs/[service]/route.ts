import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, corsOptions } from "@/src/lib/cors";

const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || "";
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || "imajin.ai";

// Map service names to their internal (server-side) URLs
const SERVICE_URLS: Record<string, string> = {
  auth: process.env.AUTH_SERVICE_URL || "http://localhost:3001",
  pay: process.env.PAY_SERVICE_URL || "http://localhost:3004",
  profile: process.env.PROFILE_SERVICE_URL || "http://localhost:3005",
  events: process.env.EVENTS_SERVICE_URL || "http://localhost:3006",
  chat: process.env.CHAT_SERVICE_URL || "http://localhost:3007",
  registry: "http://localhost:" + (process.env.PORT || "3002"),
  connections: process.env.CONNECTIONS_SERVICE_URL || "http://localhost:3003",
  coffee: process.env.COFFEE_SERVICE_URL || "http://localhost:3100",
  links: process.env.LINKS_SERVICE_URL || "http://localhost:3102",
  dykil: process.env.DYKIL_SERVICE_URL || "http://localhost:3101",
  media: process.env.MEDIA_SERVICE_URL || "http://localhost:3009",
};

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: { service: string } }
) {
  const cors = corsHeaders(request);
  const { service } = params;
  const internalUrl = SERVICE_URLS[service];

  if (!internalUrl) {
    return NextResponse.json({ error: "Unknown service" }, { status: 404, headers: cors });
  }

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
