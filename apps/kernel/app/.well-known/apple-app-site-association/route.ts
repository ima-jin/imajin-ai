import { NextResponse } from "next/server";

/**
 * /.well-known/apple-app-site-association — iOS Universal Links / Webcredentials
 *
 * Establishes cross-subdomain trust for iOS. When the platform
 * ships as a PWA or native app, this enables seamless auth
 * handoff across subdomains.
 *
 * Generated dynamically from NEXT_PUBLIC_DOMAIN for federation.
 */

const SERVICES = [
  "auth",
  "pay",
  "profile",
  "registry",
  "events",
  "chat",
  "connections",
  "coffee",
  "links",
  "dykil",
  "karaoke",
  "fixready",
  "learn",
];

export function GET() {
  const domain = process.env.NEXT_PUBLIC_DOMAIN || "imajin.ai";

  const association = {
    webcredentials: {
      apps: [],
    },
    applinks: {
      apps: [],
      details: SERVICES.map((service) => ({
        appID: `*.${domain}`,
        paths: ["*"],
        components: [
          {
            "/": "/*",
            comment: `${service}.${domain}`,
          },
        ],
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
