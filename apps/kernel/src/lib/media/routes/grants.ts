import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { corsHeaders } from "@/src/lib/kernel/cors";
import { applyGrants } from "@/src/lib/media/apply-grants";

export async function patchGrants(
  request: NextRequest,
  id: string
): Promise<NextResponse> {
  const cors = corsHeaders(request);

  // 1. Auth
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status, headers: cors }
    );
  }
  const requesterDid = resolveActingDid(authResult.identity);

  // 2. Parse body
  let body: { add?: unknown; remove?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors }
    );
  }

  const add = Array.isArray(body.add) ? (body.add as unknown[]).filter((d): d is string => typeof d === "string") : [];
  const remove = Array.isArray(body.remove) ? (body.remove as unknown[]).filter((d): d is string => typeof d === "string") : [];

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.MEDIA_PUBLIC_URL ||
    new URL(request.url).origin;

  // 3–6. Delegate to pure lib (load, auth-check, manifest update, DB write)
  const result = await applyGrants(id, requesterDid, add, remove, baseUrl);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status, headers: cors });
  }

  return NextResponse.json(result.asset, { status: 200, headers: cors });
}
