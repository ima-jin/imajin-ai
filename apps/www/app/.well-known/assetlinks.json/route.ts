import { NextResponse } from "next/server";

/**
 * /.well-known/assetlinks.json — Android Digital Asset Links
 *
 * Declares all subdomains as trusted, preventing "wants to access
 * other apps and services" warnings on cross-subdomain navigation.
 *
 * Generated dynamically from NEXT_PUBLIC_DOMAIN so each node
 * in the federated network serves its own.
 */

const SERVICES = [
  "", // root domain
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
  const protocol = process.env.NEXT_PUBLIC_SERVICE_PREFIX || "https://";

  const assetLinks = SERVICES.map((service) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "web",
      site: `${protocol}${service ? `${service}.` : ""}${domain}`,
    },
  }));

  return NextResponse.json(assetLinks, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "application/json",
    },
  });
}
