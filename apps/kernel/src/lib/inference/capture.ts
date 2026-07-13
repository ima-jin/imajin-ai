/**
 * Gesture capture surface (#1211).
 *
 * Accepts a raw media buffer, creates a DID-pinned asset via the existing
 * createAsset() pipeline, opens an inference_sessions row, and publishes a
 * DFOS capture event. Voice is the v1 primary; photo/file/text are accepted.
 */

import { nanoid } from 'nanoid';
import { db, inferenceSessions } from '@/src/db';
import { createAsset } from '@/src/lib/media/create-asset';
import { publishContentEvent } from '@imajin/dfos';
import { createLogger } from '@imajin/logger';
import type { CaptureEvent, CaptureKind } from './types';

const log = createLogger('kernel:inference:capture');

export interface CaptureGestureInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  ownerDid: string;
  /** Mounted vocabulary name — stored on the session for routing. */
  vocabularyName: string;
}

/**
 * Ingest a gesture (voice/photo/file/text), create a DID-pinned media asset,
 * open an inference session, and emit an inference.capture DFOS event.
 *
 * Returns a CaptureEvent that carries the sessionId + assetId into the next
 * stage of the pipeline (context.ts → gatherContext()).
 */
export async function captureGesture(input: CaptureGestureInput): Promise<CaptureEvent> {
  const { buffer, filename, mimeType, ownerDid, vocabularyName } = input;

  // Derive capture kind from MIME type.
  const kind = mimeKind(mimeType);

  // Create DID-pinned asset. context: { feature: 'voice' } → auto-foldered to
  // "Audio Recordings" for audio; other MIME types use the feature key as-is.
  const contextFeature = kind === 'voice' ? 'voice' : kind;
  const { asset } = await createAsset({
    ownerDid,
    buffer,
    filename,
    mimeType,
    context: { feature: contextFeature },
    // inference captures are always private until explicitly shared
    access: 'private',
    dedup: false,
    classify: false,
  });

  const sessionId = `session_${nanoid(16)}`;

  // Persist the session row.
  await db.insert(inferenceSessions).values({
    id: sessionId,
    ownerDid,
    vocabularyName,
    assetId: asset.id,
    status: 'capturing',
  });

  // Publish capture event to DFOS (best-effort, never blocks).
  publishContentEvent({
    topic: 'inference.capture',
    payload: {
      sessionId,
      assetId: asset.id,
      kind,
      ownerDid,
      vocabularyName,
      capturedAt: new Date().toISOString(),
    },
  }).catch((err: unknown) => {
    log.error({ err: String(err), sessionId }, 'DFOS inference.capture publish failed (non-fatal)');
  });

  log.info({ sessionId, assetId: asset.id, kind, ownerDid, vocabularyName }, 'gesture captured');

  return { sessionId, assetId: asset.id, kind, ownerDid };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mimeKind(mimeType: string): CaptureKind {
  if (mimeType.startsWith('audio/')) return 'voice';
  if (mimeType.startsWith('image/')) return 'photo';
  if (mimeType.startsWith('text/')) return 'text';
  return 'file';
}
