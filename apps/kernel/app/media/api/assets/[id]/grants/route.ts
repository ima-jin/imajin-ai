import { NextRequest } from "next/server";
import { patchGrants } from "@/src/lib/media/routes/grants";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return patchGrants(request, id);
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
