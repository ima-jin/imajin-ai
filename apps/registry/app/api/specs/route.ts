import { NextResponse } from "next/server";

const SERVICES = [
  {
    name: "auth",
    description: "Authentication and identity",
    prod: "https://auth.imajin.ai",
    dev: "https://dev-auth.imajin.ai",
  },
  {
    name: "pay",
    description: "Payments, escrow, and balance management",
    prod: "https://pay.imajin.ai",
    dev: "https://dev-pay.imajin.ai",
  },
  {
    name: "profile",
    description: "User profiles and social graph",
    prod: "https://profile.imajin.ai",
    dev: "https://dev-profile.imajin.ai",
  },
  {
    name: "events",
    description: "Event creation, ticketing, and management",
    prod: "https://events.imajin.ai",
    dev: "https://dev-events.imajin.ai",
  },
  {
    name: "chat",
    description: "Real-time messaging and conversations",
    prod: "https://chat.imajin.ai",
    dev: "https://dev-chat.imajin.ai",
  },
  {
    name: "registry",
    description: "Node registration, heartbeat, build attestation, and subdomain provisioning",
    prod: "https://registry.imajin.ai",
    dev: "https://dev-registry.imajin.ai",
  },
  {
    name: "connections",
    description: "Social connections, pods, and trust invites",
    prod: "https://connections.imajin.ai",
    dev: "https://dev-connections.imajin.ai",
  },
  {
    name: "coffee",
    description: "Tipping and creator support pages",
    prod: "https://coffee.imajin.ai",
    dev: "https://dev-coffee.imajin.ai",
  },
  {
    name: "links",
    description: "Link-in-bio pages and click tracking",
    prod: "https://links.imajin.ai",
    dev: "https://dev-links.imajin.ai",
  },
  {
    name: "dykil",
    description: "Surveys and do-you-know-if-I-like polls",
    prod: "https://dykil.imajin.ai",
    dev: "https://dev-dykil.imajin.ai",
  },
  {
    name: "media",
    description: "Media asset management, upload, and classification",
    prod: "https://media.imajin.ai",
    dev: "https://dev-media.imajin.ai",
  },
];

export async function GET() {
  return NextResponse.json({
    services: SERVICES.map((s) => ({
      name: s.name,
      description: s.description,
      prod: s.prod,
      dev: s.dev,
      spec: `${s.prod}/api/spec`,
    })),
  });
}
