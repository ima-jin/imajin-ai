import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, corsOptions } from "@/src/lib/cors";

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
  { name: "input", description: "Media upload relay and Whisper transcription" },
  { name: "media", description: "Media asset management, upload, and classification" },
  { name: "coffee", description: "Tipping and creator support pages" },
  { name: "dykil", description: "Surveys and do-you-know-if-I-like polls" },
  { name: "links", description: "Link-in-bio pages and click tracking" },
  { name: "learn", description: "Courses, lessons, and learning progress" },
];

function buildServiceUrl(name: string): string {
  // SERVICE_PREFIX may be "https://dev-" or just "dev" or empty
  const prefix = SERVICE_PREFIX.replace(/^https?:\/\//, '').replace(/-$/, '');
  const subdomain = prefix ? `${prefix}-${name}` : name;
  return `https://${subdomain}.${DOMAIN}`;
}

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  return NextResponse.json({
    services: SERVICES.map((s) => {
      const url = buildServiceUrl(s.name);
      return {
        name: s.name,
        description: s.description,
        url,
        spec: `${url}/api/spec`,
      };
    }),
  }, { headers: cors });
}
