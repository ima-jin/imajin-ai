import { NextRequest } from "next/server";
import { patchArticle } from "@/src/lib/media/routes/article";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return patchArticle(request, id);
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
