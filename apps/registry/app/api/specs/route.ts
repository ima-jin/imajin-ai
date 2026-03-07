import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, corsOptions } from "@/src/lib/cors";

const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || "";
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || "imajin.ai";

export type ServiceVisibility = "public" | "authenticated" | "creator" | "internal";
export type ServiceCategory = "core" | "creator" | "developer" | "infrastructure";

export interface ServiceEntry {
  name: string;
  description: string;
  icon: string;
  label: string;
  visibility: ServiceVisibility;
  category: ServiceCategory;
}

const SERVICES: ServiceEntry[] = [
  { name: "www", description: "Home — the Imajin network", icon: "🏠", label: "Home", visibility: "public", category: "core" },
  { name: "events", description: "Event creation, ticketing, and management", icon: "🎫", label: "Events", visibility: "public", category: "core" },
  { name: "connections", description: "Social connections, pods, and trust invites", icon: "🤝", label: "Connections", visibility: "authenticated", category: "core" },
  { name: "chat", description: "Real-time messaging and conversations", icon: "💬", label: "Messages", visibility: "authenticated", category: "core" },
  { name: "media", description: "Media asset management, upload, and classification", icon: "🖼️", label: "Media", visibility: "authenticated", category: "core" },
  { name: "profile", description: "User profiles and social graph", icon: "👤", label: "Profile", visibility: "authenticated", category: "core" },
  { name: "pay", description: "Payments, escrow, and balance management", icon: "💳", label: "Pay", visibility: "authenticated", category: "core" },
  { name: "learn", description: "Courses, lessons, and learning progress", icon: "📚", label: "Learn", visibility: "public", category: "core" },
  { name: "coffee", description: "Tipping and creator support pages", icon: "☕", label: "Coffee", visibility: "creator", category: "creator" },
  { name: "links", description: "Link-in-bio pages and click tracking", icon: "🔗", label: "Links", visibility: "creator", category: "creator" },
  { name: "dykil", description: "Surveys and do-you-know-if-I-like polls", icon: "📋", label: "Surveys", visibility: "creator", category: "creator" },
  { name: "registry", description: "Node registration, heartbeat, and subdomain provisioning", icon: "📡", label: "Registry", visibility: "authenticated", category: "developer" },
  { name: "auth", description: "Authentication and identity", icon: "🔐", label: "Auth", visibility: "internal", category: "infrastructure" },
  { name: "input", description: "Media upload relay and Whisper transcription", icon: "📥", label: "Input", visibility: "internal", category: "infrastructure" },
];

function buildServiceUrl(name: string): string {
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
        icon: s.icon,
        label: s.label,
        visibility: s.visibility,
        category: s.category,
        url,
        spec: `${url}/api/spec`,
      };
    }),
  }, { headers: cors });
}
