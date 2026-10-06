import { NextRequest } from "next/server";
import { patchAccess } from "@/src/lib/media/routes/access";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return patchAccess(request, id);
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
