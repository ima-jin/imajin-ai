import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

let cachedSpec: string | null = null;

function getSpec(): string {
  if (!cachedSpec) {
    cachedSpec = readFileSync(join(process.cwd(), "api-spec/openapi.yaml"), "utf-8");
  }
  return cachedSpec;
}

export async function GET() {
  const spec = getSpec();
  return new NextResponse(spec, {
    headers: { "Content-Type": "text/yaml" },
  });
}
