/**
 * DFOS content event publishing.
 *
 * Publishes signed content events to the DFOS federation relay and
 * provides retrieval for verification.
 */

import { createSigner } from './signer';

/** Payload for a published fair manifest event */
export interface FairManifestPublishedPayload {
  assetId: string;
  ownerDid: string;
  manifestDigest: string;
  manifestUrl: string;
  fairVersion: string;
  signedAt: string;
}

/** Generic DFOS content event payload */
export type ContentEventPayload = FairManifestPublishedPayload | Record<string, unknown>;

/** Input to publishContentEvent */
export interface PublishContentEventInput {
  topic: string;
  payload: ContentEventPayload;
}

/** Result of a successful publish */
export interface PublishedContentEvent {
  eventId: string;
  anchoredAt: string;
}

/** Retrieved content event from DFOS relay */
export interface ContentEvent {
  topic: string;
  payload: ContentEventPayload;
  anchoredAt: string;
  signature: string;
}

/**
 * Publish a signed content event to the DFOS federation relay.
 *
 * Uses the identity's private key (from DFOS_PRIVATE_KEY_HEX env) to sign
 * the event payload. The relay anchors the event and returns an eventId.
 */
export async function publishContentEvent(
  input: PublishContentEventInput,
): Promise<PublishedContentEvent | null> {
  const relayUrl = process.env.DFOS_RELAY_URL;
  if (!relayUrl) {
    return null;
  }

  const privateKeyHex = process.env.DFOS_PRIVATE_KEY_HEX || process.env.AUTH_PRIVATE_KEY;
  if (!privateKeyHex) {
    throw new Error('DFOS_PRIVATE_KEY_HEX (or AUTH_PRIVATE_KEY) is not configured');
  }

  const signer = createSigner(privateKeyHex);

  // Canonical payload: sorted keys, no whitespace
  const canonicalPayload = canonicalize(input.payload);
  const payloadBytes = new TextEncoder().encode(canonicalPayload);

  // Sign the canonical payload
  const signature = await signer(payloadBytes);
  const signatureHex = bytesToHex(signature);

  const body = {
    topic: input.topic,
    payload: input.payload,
    signature: signatureHex,
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(`${relayUrl}/api/v1/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`DFOS relay returned ${response.status}: ${text}`);
  }

  const result = (await response.json()) as {
    eventId: string;
    anchoredAt: string;
  };

  return {
    eventId: result.eventId,
    anchoredAt: result.anchoredAt,
  };
}

/**
 * Fetch a published content event from the DFOS relay by eventId.
 *
 * Returns null if the event is not found.
 */
export async function getContentEvent(
  eventId: string,
): Promise<ContentEvent | null> {
  const relayUrl = process.env.DFOS_RELAY_URL;
  if (!relayUrl) {
    return null;
  }

  const response = await fetch(`${relayUrl}/api/v1/events/${encodeURIComponent(eventId)}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`DFOS relay returned ${response.status}: ${text}`);
  }

  const result = (await response.json()) as ContentEvent;
  return result;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Deterministic JSON canonicalization: sorted keys, no whitespace */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  const parts = keys.map((key) => JSON.stringify(key) + ':' + canonicalize(obj[key]));
  return '{' + parts.join(',') + '}';
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
