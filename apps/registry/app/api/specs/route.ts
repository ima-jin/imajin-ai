import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, corsOptions, SERVICES, getPublicUrl } from "@imajin/config";
import type { ServiceVisibility, ServiceCategory } from "@imajin/config";

const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || "";
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || "imajin.ai";

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const prefix = SERVICE_PREFIX.replace(/^https?:\/\//, "").replace(/-$/, "") || undefined;

  return NextResponse.json({
    services: SERVICES.map((s) => {
      const url = getPublicUrl(s.name, { prefix, domain: DOMAIN });
      const isExternal = !!(s.externalUrl || s.wwwPath);
      return {
        name: s.name,
        description: s.description,
        icon: s.icon,
        label: s.label,
        visibility: s.visibility as ServiceVisibility,
        category: s.category as ServiceCategory,
        url,
        ...(isExternal && { externalUrl: url }),
        ...(!isExternal && { spec: `${url}/api/spec` }),
      };
    }),
  }, { headers: cors });
}
