import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, assets, type Asset } from "@/src/db";
import { createLogger } from "@imajin/logger";

const log = createLogger("kernel");

function uploadDir(): string {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  language?: string;
  languageProbability?: number;
  durationSeconds?: number;
  processingTimeMs?: number;
  model?: string;
  segments: TranscriptSegment[];
  transcribedAt: string;
}

export type TranscribeAssetResult =
  | { ok: true; assetId: string; transcript: Transcript; cached: boolean }
  | { ok: false; status: number; message: string };

/** Whether an asset's MIME type can be sent to Whisper for transcription. */
export function isTranscribable(mime: string): boolean {
  return mime.startsWith("audio/") || mime.startsWith("video/");
}

/** Read the asset's bytes from disk, falling back to UPLOAD_DIR/filename. */
async function readAssetBytes(asset: Asset): Promise<Buffer | null> {
  const dir = uploadDir();
  const filePath = asset.storagePath || path.join(dir, asset.filename);
  try {
    return await readFile(filePath);
  } catch {
    try {
      return await readFile(path.join(dir, asset.filename));
    } catch {
      return null;
    }
  }
}

/** Relay asset bytes to the Whisper service and normalize its response. */
async function callWhisper(
  whisperUrl: string,
  buffer: Buffer,
  filename: string,
  mime: string,
  requesterDid: string,
): Promise<Transcript> {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(buffer)], { type: mime }), filename);

  const headers: Record<string, string> = { "X-Caller-DID": requesterDid };
  const whisperAuth = process.env.WHISPER_AUTH_TOKEN || "";
  if (whisperAuth) headers["Authorization"] = `Bearer ${whisperAuth}`;

  const whisperRes = await fetch(`${whisperUrl}/api/whisper/transcribe`, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!whisperRes.ok) {
    const err = await whisperRes.text();
    log.error({ status: whisperRes.status, err }, "Whisper error");
    throw new Error(`Transcription failed: ${err}`);
  }

  const result = await whisperRes.json();
  return {
    text: result.text,
    language: result.language,
    languageProbability: result.language_probability,
    durationSeconds: result.duration_seconds,
    processingTimeMs: result.processing_time_ms,
    model: result.model,
    segments: (result.segments ?? []).map((s: { start: number; end: number; text: string }) => ({
      start: s.start,
      end: s.end,
      text: s.text,
    })),
    transcribedAt: new Date().toISOString(),
  };
}

/**
 * Owner-gated audio/video transcription pipeline (#2185).
 *
 * Extracted from GET /media/api/assets/[id]/transcribe so the HTTP route and
 * the media_transcribe MCP tool share one path (mirrors updateAssetContent /
 * applyGrants): load + authorize the asset, return a cached transcript when
 * one is already pinned, otherwise read the bytes and relay them to Whisper,
 * pinning the result to `asset.metadata.transcript`. Callers own transport
 * concerns (HTTP auth, MCP scope grant) and map the returned status/message.
 */
export async function transcribeAsset(assetId: string, requesterDid: string): Promise<TranscribeAssetResult> {
  const whisperUrl = process.env.WHISPER_URL;
  if (!whisperUrl) {
    log.error({}, "WHISPER_URL is not configured");
    return { ok: false, status: 503, message: "Transcription service unavailable" };
  }

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) {
    return { ok: false, status: 404, message: "Asset not found" };
  }
  if (asset.ownerDid !== requesterDid) {
    return { ok: false, status: 403, message: "Not your asset" };
  }

  const mime = (asset.mimeType || "").toLowerCase();
  if (!isTranscribable(mime)) {
    return { ok: false, status: 400, message: `Not an audio/video asset (${mime})` };
  }

  const metadata = (asset.metadata as Record<string, unknown>) || {};
  if (metadata.transcript) {
    return { ok: true, assetId, transcript: metadata.transcript as Transcript, cached: true };
  }

  const fileBuffer = await readAssetBytes(asset);
  if (!fileBuffer) {
    return { ok: false, status: 404, message: "Asset file not found on disk" };
  }

  let transcript: Transcript;
  try {
    transcript = await callWhisper(whisperUrl, fileBuffer, asset.filename, mime, requesterDid);
  } catch (err) {
    log.error({ err: String(err), assetId }, "Whisper request failed");
    return { ok: false, status: 502, message: err instanceof Error ? err.message : "Failed to reach Whisper service" };
  }

  await db
    .update(assets)
    .set({ metadata: { ...metadata, transcript } })
    .where(eq(assets.id, assetId));

  return { ok: true, assetId, transcript, cached: false };
}
