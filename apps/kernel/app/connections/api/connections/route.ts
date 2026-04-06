import { NextRequest, NextResponse } from 'next/server';
import { db, connections, nicknames } from '../../../src/db/index';
import { corsHeaders, corsOptions, withCors } from '@/src/lib/kernel/cors';
import { requireAuth } from '@imajin/auth';
import { eq, or, and, isNull, inArray } from 'drizzle-orm';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  const did = identity.actingAs || identity.id;

  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        or(eq(connections.didA, did), eq(connections.didB, did)),
        isNull(connections.disconnectedAt)
      )
    );

  // Map so `did` is the OTHER person's DID
  const mapped = rows.map((row) => ({
    did: row.didA === did ? row.didB : row.didA,
    connectedAt: row.connectedAt,
  }));

  // Batch-fetch nicknames set by this user
  const targetDids = mapped.map((c) => c.did);
  const nicknameRows = targetDids.length > 0
    ? await db
        .select()
        .from(nicknames)
        .where(and(eq(nicknames.did, did), inArray(nicknames.target, targetDids)))
    : [];
  const nicknameMap = new Map(nicknameRows.map((n) => [n.target, n.nickname]));

  // Resolve handles from auth service
  const resolved = await Promise.all(
    mapped.map(async (conn) => {
      const nickname = nicknameMap.get(conn.did) ?? null;
      try {
        const lookupRes = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(conn.did)}`);
        if (lookupRes.ok) {
          const data = await lookupRes.json();
          const identity = data.identity || data;
          return { ...conn, nickname, handle: identity.handle || null, name: identity.name || null };
        }
      } catch {}
      return { ...conn, nickname, handle: null, name: null };
    })
  );

  return withCors(NextResponse.json({ connections: resolved }), request);
}
