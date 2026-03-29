import { MemoryRelayStore } from '@metalabel/dfos-web-relay';
import type { Hono } from 'hono';
import { PostgresRelayStore } from '@/src/relay/postgres-store';
import { createCustomRelay } from '@/src/relay/create-relay';
import { db } from '@/src/db';

const RELAY_DID = process.env.RELAY_DID;
const RELAY_PROFILE_JWS = process.env.RELAY_PROFILE_JWS;

const store =
  process.env.RELAY_STORE === 'memory'
    ? new MemoryRelayStore()
    : new PostgresRelayStore(db);

// Lazy singleton — top-level await is not available in Next.js route files
let relayInstance: Hono | null = null;
let relayInitPromise: Promise<Hono> | null = null;

function initRelay(): Promise<Hono> {
  const identity =
    RELAY_DID && RELAY_PROFILE_JWS
      ? { did: RELAY_DID, profileArtifactJws: RELAY_PROFILE_JWS }
      : undefined;

  return createCustomRelay({ store, identity });
}

async function getRelay(): Promise<Hono> {
  if (relayInstance) return relayInstance;
  if (!relayInitPromise) {
    relayInitPromise = initRelay().then((r) => {
      relayInstance = r;
      return r;
    });
  }
  return relayInitPromise;
}

async function handler(request: Request) {
  const relay = await getRelay();

  const url = new URL(request.url);
  const relayPath = url.pathname.replace(/^\/relay/, '') || '/';
  const relayUrl = new URL(relayPath, url.origin);
  relayUrl.search = url.search;

  const relayRequest = new Request(relayUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    // @ts-expect-error duplex needed for streaming body
    duplex: 'half',
  });

  return relay.fetch(relayRequest);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
