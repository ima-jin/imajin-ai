import { MemoryRelayStore } from '@metalabel/dfos-web-relay';
import type { Hono } from 'hono';
import type { PeerConfig } from '@metalabel/dfos-web-relay';
import { eq } from 'drizzle-orm';
import { PostgresRelayStore } from '@/src/lib/registry/relay/postgres-store';
import { createCustomRelay } from '@/src/lib/registry/relay/create-relay';
import {
  RELAY_WRITER_DID_HEADER,
  authorizeRelayWrite,
  isRelayWrite,
  isRelayWriteDenied,
} from '@/src/lib/registry/relay/auth';
import { db } from '@/src/db';
import { relayConfig, relayPeers } from '@/src/db/schemas/relay';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const RELAY_DID = process.env.RELAY_DID;
const RELAY_PROFILE_JWS = process.env.RELAY_PROFILE_JWS;

const store =
  process.env.RELAY_STORE === 'memory'
    ? new MemoryRelayStore()
    : new PostgresRelayStore(db);

// Lazy singleton — top-level await is not available in Next.js route files
let relayApp: Hono | null = null;
let relayInitPromise: Promise<Hono> | null = null;
let relaySyncFromPeers: (() => Promise<void>) | null = null;
let syncIntervalId: ReturnType<typeof setInterval> | null = null;

const SYNC_INTERVAL_MS = 60_000; // 60 seconds

async function loadPeersFromDB(): Promise<PeerConfig[]> {
  const rows = await db
    .select()
    .from(relayPeers)
    .where(eq(relayPeers.enabled, 1));

  return rows.map((row) => ({
    url: row.peerUrl,
    push: row.push === 1,
    fetch: row.fetch === 1,
    sync: row.sync === 1,
  }));
}

function startSyncInterval() {
  if (syncIntervalId) return;
  syncIntervalId = setInterval(async () => {
    if (!relaySyncFromPeers) return;
    try {
      await relaySyncFromPeers();
    } catch (err) {
      log.error({ err }, '[relay] Peer sync failed');
    }
  }, SYNC_INTERVAL_MS);
}

async function initRelay(): Promise<Hono> {
  const peers = await loadPeersFromDB();
  if (peers.length > 0) {
    log.info({ peerCount: peers.length }, '[relay] Loaded peers from DB');
  }

  // 1. Env override takes priority (if chain exists in store)
  if (RELAY_DID && RELAY_PROFILE_JWS) {
    const chain = await store.getIdentityChain(RELAY_DID);
    if (chain) {
      const result = await createCustomRelay({
        store,
        identity: { did: RELAY_DID, profileArtifactJws: RELAY_PROFILE_JWS },
        content: true,
        peers,
      });
      relaySyncFromPeers = result.syncFromPeers;
      if (peers.length > 0) startSyncInterval();
      return result.app;
    }
    log.warn({ relayDid: RELAY_DID }, '[relay] RELAY_DID configured but chain missing — falling through to DB');
  }

  // 2. Check DB for persisted identity
  const configs = await db.select().from(relayConfig).where(eq(relayConfig.id, 'singleton'));
  const config = configs[0];
  if (config) {
    const chain = await store.getIdentityChain(config.did);
    if (chain) {
      log.info({ did: config.did }, '[relay] Using persisted identity');
      const result = await createCustomRelay({
        store,
        identity: { did: config.did, profileArtifactJws: config.profileArtifactJws },
        content: true,
        peers,
      });
      relaySyncFromPeers = result.syncFromPeers;
      if (peers.length > 0) startSyncInterval();
      return result.app;
    }
    log.warn({ did: config.did }, '[relay] Persisted identity has no chain — re-bootstrapping');
  }

  // 3. Bootstrap fresh — library creates identity + ingests chain
  const result = await createCustomRelay({ store, content: true, peers });
  relaySyncFromPeers = result.syncFromPeers;
  if (peers.length > 0) startSyncInterval();

  // Fetch the profile JWS from the well-known endpoint
  const wellKnownReq = new Request('http://localhost/.well-known/dfos-relay');
  const wellKnownRes = await result.app.fetch(wellKnownReq);
  const wellKnown = await wellKnownRes.json() as { did: string; profile: string };

  // Persist to DB
  await db
    .insert(relayConfig)
    .values({
      id: 'singleton',
      did: result.did,
      profileArtifactJws: wellKnown.profile,
    })
    .onConflictDoUpdate({
      target: relayConfig.id,
      set: {
        did: result.did,
        profileArtifactJws: wellKnown.profile,
        createdAt: new Date(),
      },
    });

  log.info({ did: result.did }, '[relay] Bootstrapped and persisted new relay identity');
  return result.app;
}

async function getRelay(): Promise<Hono> {
  if (relayApp) return relayApp;
  if (!relayInitPromise) {
    relayInitPromise = initRelay().then((r) => {
      relayApp = r;
      return r;
    });
  }
  return relayInitPromise;
}

async function handler(request: Request) {
  const url = new URL(request.url);
  const relayPath = url.pathname.replace(/^\/registry\/relay/, '') || '/';

  // AuthZ (#454): writes require a verified Imajin DID; reads stay open.
  // Checked before the relay is initialised so rejected writes never touch it.
  let writerDid: string | null = null;
  if (isRelayWrite(request.method)) {
    const auth = await authorizeRelayWrite(request);
    if (isRelayWriteDenied(auth)) {
      log.warn(
        { method: request.method, path: relayPath, reason: auth.error },
        '[relay] write rejected — no verified DID',
      );
      return Response.json({ error: auth.error }, { status: auth.status });
    }
    writerDid = auth.did;
    log.info(
      { method: request.method, path: relayPath, did: auth.did, callerDid: auth.callerDid },
      '[relay] authorized write',
    );
  }

  const relay = await getRelay();

  const relayUrl = new URL(relayPath, url.origin);
  relayUrl.search = url.search;

  // Strip any client-supplied writer header so the audit value can only ever
  // come from the DID we just verified.
  const headers = new Headers(request.headers);
  headers.delete(RELAY_WRITER_DID_HEADER);
  if (writerDid) headers.set(RELAY_WRITER_DID_HEADER, writerDid);

  const relayRequest = new Request(relayUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error duplex needed for streaming body
    duplex: 'half',
  });

  return relay.fetch(relayRequest);
}

export const dynamic = 'force-dynamic';

export const GET = handler;
export const POST = handler;
export const PUT = handler;
// No relay route answers these today, but exporting them keeps the authZ gate
// in front of any mutating verb a future relay version adds.
export const PATCH = handler;
export const DELETE = handler;
