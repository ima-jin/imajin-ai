import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, corsOptions, getService, SERVICES } from "@imajin/config";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/** Kernel services serve specs from local YAML files */
const KERNEL_SERVICES = new Set(
  SERVICES.filter((s) => s.category === "kernel").map((s) => s.name)
);

const PORT = process.env.PORT || "3000";

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: { service: string } }
) {
  const cors = corsHeaders(request);
  const { service } = params;

  if (!getService(service)) {
    return NextResponse.json({ error: "Unknown service" }, { status: 404, headers: cors });
  }

  // Kernel services: read spec directly from file (same process)
  if (KERNEL_SERVICES.has(service)) {
    const specPath = join(process.cwd(), "api-spec", `${service}.yaml`);
    if (!existsSync(specPath)) {
      return NextResponse.json(
        { error: `No spec for ${service}` },
        { status: 404, headers: cors }
      );
    }
    const text = readFileSync(specPath, "utf-8");
    return new NextResponse(text, {
      headers: { ...cors, "Content-Type": "text/yaml", "Cache-Control": "public, max-age=60" },
    });
  }

  // Userspace services: fetch from their own process (must include basePath)
  const svcDef = getService(service);
  const port = svcDef ? (process.env.NODE_ENV === "production" ? svcDef.prodPort : svcDef.devPort) : 3000;
  const internalUrl = `http://localhost:${port}`;

  try {
    const res = await fetch(`${internalUrl}/${service}/api/spec`, {
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
      headers: { ...cors, "Content-Type": contentType || "text/plain", "Cache-Control": "public, max-age=60" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach ${service} service` },
      { status: 502, headers: cors }
    );
  }
}
