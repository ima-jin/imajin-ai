import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, corsOptions, SERVICES, buildPublicUrl } from "@imajin/config";
import type { ServiceVisibility, ServiceCategory } from "@imajin/config";

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  return NextResponse.json({
    services: SERVICES.map((s) => {
      const url = buildPublicUrl(s.name);
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
