import { NextRequest, NextResponse } from "next/server";
import { patchArticle } from "@/src/lib/media/routes/article";
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
  return patchArticle(request, id);
}
