/**
 * Transcription + telemetry gather (#1212).
 *
 * Turns a raw capture into an InferenceContext:
 *   1. Transcribes voice → text via the existing GPU Whisper node.
 *   2. Pins the transcript to the asset's metadata (DB update).
 *   3. Gathers the minimal ambient priors that disambiguate intent:
 *        - recent active connection DIDs (read-only, consent-respecting)
 *        - coarse time-of-day bucket
 *        - activity summary stub (future: calendar + events)
 *   4. Updates the session row with transcript + priors.
 */

import { eq } from 'drizzle-orm';
import { db, assets, inferenceSessions } from '@/src/db';
import { listConnections } from '@/src/lib/connections/list';
import { createLogger } from '@imajin/logger';
import type { InferenceContext, TelemetryPriors } from './types';

const log = createLogger('kernel:inference:context');

/** Maximum recent connections to include as telemetry priors (v1). */
const MAX_PRIOR_CONNECTIONS = 5;

// Read GPU config lazily so tests can override process.env at runtime.
function gpuNodeUrl(): string | undefined { return process.env['GPU_NODE_URL']; }
function gpuAuthToken(): string { return process.env['GPU_AUTH_TOKEN'] ?? ''; }

export async function gatherContext(
  sessionId: string,
  assetId: string,
  ownerDid: string,
): Promise<InferenceContext> {
  // 1. Fetch the asset to get storage path for transcription.
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`Asset ${assetId} not found`);

  // 2. Transcribe (voice → text). For non-audio assets, use filename as stub.
  const transcript = asset.mimeType.startsWith('audio/')
    ? await transcribeAsset(asset.storagePath, asset.mimeType, asset.filename)
    : asset.filename;

  // 3. Pin transcript to the asset metadata (best-effort, non-fatal).
  db.update(assets)
    .set({ metadata: { ...(typeof asset.metadata === 'object' && asset.metadata !== null ? asset.metadata : {}), transcript } })
    .where(eq(assets.id, assetId))
    .catch((err: unknown) => {
      log.error({ err: String(err), assetId }, 'Failed to pin transcript to asset (non-fatal)');
    });

  // 4. Gather ambient priors (read-only, consent-respecting).
  const priors = await gatherPriors(ownerDid);

  // 5. Advance session to 'inferring' with transcript + priors.
  await db
    .update(inferenceSessions)
    .set({ transcript, priors, status: 'inferring', updatedAt: new Date() })
    .where(eq(inferenceSessions.id, sessionId));

  log.info({ sessionId, assetId, transcriptLength: transcript.length }, 'context gathered');

  return { sessionId, assetId, transcript, priors };
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

async function transcribeAsset(
  storagePath: string,
  mimeType: string,
  filename: string,
): Promise<string> {
  const url = gpuNodeUrl();
  if (!url) {
    log.warn({}, 'GPU_NODE_URL not configured — returning filename as stub transcript');
    return filename;
  }

  try {
    // Read the file from the local media volume.
    const { readFile } = await import('node:fs/promises');
    const fileBytes = await readFile(storagePath);
    const blob = new Blob([fileBytes], { type: mimeType });
    const form = new FormData();
    form.append('file', new File([blob], filename, { type: mimeType }));

    const token = gpuAuthToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${url}/api/whisper/transcribe`, {
      method: 'POST',
      body: form,
      headers,
    });

    if (!res.ok) {
      log.error({ status: res.status }, 'GPU transcription failed');
      return '';
    }

    const result = await res.json() as { text?: string };
    return result.text ?? '';
  } catch (err) {
    log.error({ err: String(err) }, 'Transcription error (non-fatal)');
    return '';
  }
}

// ---------------------------------------------------------------------------
// Telemetry priors
// ---------------------------------------------------------------------------

async function gatherPriors(ownerDid: string): Promise<TelemetryPriors> {
  // Recent connections (read-only). Non-fatal — fall back to empty list.
  let recentConnectionDids: string[] = [];
  try {
    const conns = await listConnections(ownerDid);
    recentConnectionDids = conns
      .toSorted((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime())
      .slice(0, MAX_PRIOR_CONNECTIONS)
      .map((c) => c.did);
  } catch (err) {
    log.warn({ err: String(err), ownerDid }, 'Failed to gather connection priors (non-fatal)');
  }

  return {
    recentConnectionDids,
    timeOfDay: timeOfDayBucket(),
    // v1 stub — future: assemble from calendar (#241) + events activity
    recentActivitySummary: '',
  };
}

function timeOfDayBucket(): TelemetryPriors['timeOfDay'] {
  const hour = new Date().getUTCHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}
