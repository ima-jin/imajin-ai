import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveActingDid } from "@imajin/auth";

export const dynamic = "force-dynamic";
import { corsHeaders } from "@imajin/config";
import { transcribeAsset } from "@/src/lib/media/transcribe-asset";

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/assets/[id]/transcribe
 *
 * Sends an audio/video asset to Whisper for transcription.
 * Stores the transcript in asset metadata.
 * Returns the transcript with segments and timing.
 *
 * Delegates to the shared transcribeAsset pipeline (#2185) so this route and
 * the media_transcribe MCP tool share one owner-gated path; this route owns
 * only the HTTP auth concern.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status, headers: cors }
    );
  }

  const { id } = await params;
  const ownerDid = resolveActingDid(authResult.identity);

  const result = await transcribeAsset(id, ownerDid);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status, headers: cors });
  }

  return NextResponse.json({ transcript: result.transcript, cached: result.cached }, { headers: cors });
}
