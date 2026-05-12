import { NextRequest, NextResponse } from "next/server";
import { patchAccess } from "@/src/lib/media/routes/access";
import { corsOptions } from "@/src/lib/kernel/cors";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return patchAccess(request, id);
}
