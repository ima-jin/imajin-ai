import { NextRequest, NextResponse } from "next/server";

const SERVICE_URLS: Record<string, string> = {
  auth: process.env.AUTH_SERVICE_URL ?? "https://auth.imajin.ai",
  pay: process.env.PAY_SERVICE_URL ?? "https://pay.imajin.ai",
  profile: process.env.PROFILE_SERVICE_URL ?? "https://profile.imajin.ai",
  events: process.env.EVENTS_SERVICE_URL ?? "https://events.imajin.ai",
  chat: process.env.CHAT_SERVICE_URL ?? "https://chat.imajin.ai",
  registry: process.env.REGISTRY_SERVICE_URL ?? "https://registry.imajin.ai",
  connections: process.env.CONNECTIONS_SERVICE_URL ?? "https://connections.imajin.ai",
  coffee: process.env.COFFEE_SERVICE_URL ?? "https://coffee.imajin.ai",
  links: process.env.LINKS_SERVICE_URL ?? "https://links.imajin.ai",
  dykil: process.env.DYKIL_SERVICE_URL ?? "https://dykil.imajin.ai",
  media: process.env.MEDIA_SERVICE_URL ?? "https://media.imajin.ai",
};

export async function GET(
  _request: NextRequest,
  { params }: { params: { service: string } }
) {
  const { service } = params;
  const baseUrl = SERVICE_URLS[service];

  if (!baseUrl) {
    return NextResponse.json({ error: `Unknown service: ${service}` }, { status: 404 });
  }

  const res = await fetch(`${baseUrl}/api/spec`, {
    headers: { Accept: "text/yaml" },
  });

  if (!res.ok) {
    return NextResponse.json(
      { error: `Failed to fetch spec for ${service}: ${res.status}` },
      { status: res.status }
    );
  }

  const body = await res.text();
  return new NextResponse(body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "text/yaml",
    },
  });
}
