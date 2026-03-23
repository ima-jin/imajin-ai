import { createRelay, MemoryRelayStore } from '@metalabel/dfos-web-relay';
import { PostgresRelayStore } from '@/src/relay/postgres-store';
import { db } from '@/src/db';

const RELAY_DID = process.env.RELAY_DID || 'did:imajin:relay-dev';

const store =
  process.env.RELAY_STORE === 'memory'
    ? new MemoryRelayStore()
    : new PostgresRelayStore(db);

const relay = createRelay({ relayDID: RELAY_DID, store });

async function handler(request: Request) {
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
