import { NextRequest, NextResponse } from "next/server";

const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || "";
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || "imajin.ai";

const SERVICES = [
  { name: "auth", description: "Authentication and identity" },
  { name: "pay", description: "Payments, escrow, and balance management" },
  { name: "profile", description: "User profiles and social graph" },
  { name: "events", description: "Event creation, ticketing, and management" },
  { name: "chat", description: "Real-time messaging and conversations" },
  { name: "registry", description: "Node registration, heartbeat, and subdomain provisioning" },
  { name: "connections", description: "Social connections, pods, and trust invites" },
  { name: "coffee", description: "Tipping and creator support pages" },
  { name: "links", description: "Link-in-bio pages and click tracking" },
  { name: "dykil", description: "Surveys and do-you-know-if-I-like polls" },
  { name: "media", description: "Media asset management, upload, and classification" },
];

export async function GET(request: NextRequest) {
  const prefix = SERVICE_PREFIX ? `${SERVICE_PREFIX}-` : "";
  
  return NextResponse.json({
    services: SERVICES.map((s) => ({
      name: s.name,
      description: s.description,
      url: `https://${prefix}${s.name}.${DOMAIN}`,
      spec: `https://${prefix}${s.name}.${DOMAIN}/api/spec`,
    })),
  });
}
