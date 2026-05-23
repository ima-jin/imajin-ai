import { NextRequest, NextResponse } from 'next/server';
import { db, identities, profiles } from '@/src/db';
import { ilike, or, and, ne, eq, sql } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

interface SearchResult {
  did: string;
  handle: string | null;
  name: string | null;
  scope: string;
  subtype: string | null;
  avatarUrl: string | null;
  avatarAssetId: string | null;
}

/**
 * GET /auth/api/search?q=<query>&limit=5
 * Fuzzy search identities by handle or display name.
 * Excludes soft-tier identities (they don't have handles).
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim() ?? '';
    const rawLimit = Number.parseInt(searchParams.get('limit') ?? '5', 10);
    const limit = Math.min(Math.max(rawLimit, 1), 20);

    if (!q || q.length < 2) {
      return NextResponse.json({ results: [] }, { headers: cors });
    }

    const searchPattern = `%${q}%`;

    const rows = await db
      .select({
        did: identities.id,
        handle: identities.handle,
        name: identities.name,
        scope: identities.scope,
        subtype: identities.subtype,
        avatarUrl: identities.avatarUrl,
        avatarAssetId: identities.avatarAssetId,
        profileAvatar: profiles.avatar,
        profileAvatarAssetId: profiles.avatarAssetId,
      })
      .from(identities)
      .leftJoin(profiles, eq(identities.id, profiles.did))
      .where(
        and(
          ne(identities.tier, 'soft'),
          or(
            ilike(identities.handle, searchPattern),
            ilike(identities.name, searchPattern),
            ilike(identities.id, searchPattern)
          )
        )
      )
      .limit(limit)
      .orderBy(sql`CASE WHEN ${identities.handle} ILIKE ${q + '%'} THEN 0 ELSE 1 END`, identities.name);

    const results: SearchResult[] = rows.map((row) => ({
      did: row.did,
      handle: row.handle,
      name: row.name,
      scope: row.scope,
      subtype: row.subtype,
      avatarUrl: row.avatarUrl ?? row.profileAvatar ?? null,
      avatarAssetId: row.avatarAssetId ?? row.profileAvatarAssetId ?? null,
    }));

    return NextResponse.json({ results }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Search error');
    return NextResponse.json(
      { error: 'Failed to search identities' },
      { status: 500, headers: cors }
    );
  }
}
