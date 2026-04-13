import { MemoryRelayStore } from '@metalabel/dfos-web-relay';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { PostgresRelayStore } from '@/src/lib/registry/relay/postgres-store';
import { createCustomRelay } from '@/src/lib/registry/relay/create-relay';
import { db } from '@/src/db';
import { relayConfig } from '@/src/db/schemas/relay';
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

async function initRelay(): Promise<Hono> {
  // 1. Env override takes priority (if chain exists in store)
  if (RELAY_DID && RELAY_PROFILE_JWS) {
    const chain = await store.getIdentityChain(RELAY_DID);
    if (chain) {
      const { app } = await createCustomRelay({
        store,
        identity: { did: RELAY_DID, profileArtifactJws: RELAY_PROFILE_JWS },
      });
      return app;
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
      const { app } = await createCustomRelay({
        store,
        identity: { did: config.did, profileArtifactJws: config.profileArtifactJws },
      });
      return app;
    }
    log.warn({ did: config.did }, '[relay] Persisted identity has no chain — re-bootstrapping');
  }

  // 3. Bootstrap fresh — library creates identity + ingests chain
  const { app, did } = await createCustomRelay({ store });

  // Fetch the profile JWS from the well-known endpoint
  const wellKnownReq = new Request('http://localhost/.well-known/dfos-relay');
  const wellKnownRes = await app.fetch(wellKnownReq);
  const wellKnown = await wellKnownRes.json() as { did: string; profile: string };

  // Persist to DB
  await db
    .insert(relayConfig)
    .values({
      id: 'singleton',
      did,
      profileArtifactJws: wellKnown.profile,
    })
    .onConflictDoUpdate({
      target: relayConfig.id,
      set: {
        did,
        profileArtifactJws: wellKnown.profile,
        createdAt: new Date(),
      },
    });

  log.info({ did }, '[relay] Bootstrapped and persisted new relay identity');
  return app;
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
  const relay = await getRelay();

  const url = new URL(request.url);
  const relayPath = url.pathname.replace(/^\/registry\/relay/, '') || '/';
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
