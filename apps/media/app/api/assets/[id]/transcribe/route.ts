import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { db, assets } from "@/src/db";
import { requireAuth } from "@imajin/auth";

export const dynamic = "force-dynamic";
import { eq } from "drizzle-orm";
import { corsHeaders } from "@imajin/config";

const WHISPER_URL = process.env.WHISPER_URL || "http://192.168.1.234:8765";
const WHISPER_AUTH = process.env.WHISPER_AUTH_TOKEN || "";
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");

function isTranscribable(mime: string): boolean {
  return mime.startsWith("audio/") || mime.startsWith("video/");
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/assets/[id]/transcribe
 * 
 * Sends an audio/video asset to Whisper for transcription.
 * Stores the transcript in asset metadata.
 * Returns the transcript with segments and timing.
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
  const { identity } = authResult;

  // 1. Look up asset
  const [asset] = await db
    .select()
    .from(assets)
    .where(eq(assets.id, id))
    .limit(1);

  if (!asset) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404, headers: cors });
  }

  // 2. Check ownership
  if (asset.ownerDid !== identity.id) {
    return NextResponse.json({ error: "Not your asset" }, { status: 403, headers: cors });
  }

  // 3. Check mime type
  const mime = (asset.mimeType || "").toLowerCase();
  if (!isTranscribable(mime)) {
    return NextResponse.json(
      { error: `Not an audio/video asset (${mime})` },
      { status: 400, headers: cors }
    );
  }

  // 4. Check if already transcribed
  const metadata = (asset.metadata as Record<string, unknown>) || {};
  if (metadata.transcript) {
    return NextResponse.json(
      {
        transcript: metadata.transcript,
        cached: true,
      },
      { headers: cors }
    );
  }

  // 5. Read file from disk
  const filePath = path.join(UPLOAD_DIR, asset.filename);
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(filePath);
  } catch {
    return NextResponse.json(
      { error: "Asset file not found on disk" },
      { status: 404, headers: cors }
    );
  }

  // 6. Send to Whisper
  try {
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([fileBuffer], { type: mime }),
      asset.filename
    );

    const headers: Record<string, string> = {
      "X-Caller-DID": identity.id,
    };
    if (WHISPER_AUTH) {
      headers["Authorization"] = `Bearer ${WHISPER_AUTH}`;
    }

    const whisperRes = await fetch(`${WHISPER_URL}/api/whisper/transcribe`, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.text();
      console.error("Whisper error:", whisperRes.status, err);
      return NextResponse.json(
        { error: "Transcription failed", detail: err },
        { status: 502, headers: cors }
      );
    }

    const result = await whisperRes.json();

    // 7. Store transcript in asset metadata
    const transcript = {
      text: result.text,
      language: result.language,
      languageProbability: result.language_probability,
      durationSeconds: result.duration_seconds,
      processingTimeMs: result.processing_time_ms,
      model: result.model,
      segments: result.segments.map((s: any) => ({
        start: s.start,
        end: s.end,
        text: s.text,
      })),
      transcribedAt: new Date().toISOString(),
    };

    await db
      .update(assets)
      .set({
        metadata: { ...metadata, transcript },
      })
      .where(eq(assets.id, id));

    return NextResponse.json({ transcript, cached: false }, { headers: cors });
  } catch (err) {
    console.error("Whisper request failed:", err);
    return NextResponse.json(
      { error: "Failed to reach Whisper service" },
      { status: 502, headers: cors }
    );
  }
}
