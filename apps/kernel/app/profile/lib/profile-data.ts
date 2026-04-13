import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME } from '@imajin/config';
import { db, profiles, follows, connections, identityMembers, forestConfig } from '@/src/db';
import { getClient } from '@imajin/db';
import { eq, count, and, isNull } from 'drizzle-orm';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import type { ProfileData, ProfileCounts, LinkItem, IdentityInfo } from './types';

export interface MemberEntry {
  role: string;
  did: string;
  displayName: string;
  handle?: string;
  avatar?: string;
}

export async function getViewerDid(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const session = cookieStore.get(SESSION_COOKIE_NAME);
    if (!session?.value) return null;
    const kernelSession = await getSessionFromCookies(`${SESSION_COOKIE_NAME}=${session.value}`);
    return kernelSession?.did ?? null;
  } catch { return null; }
}

export async function isConnected(viewerDid: string, targetDid: string): Promise<boolean> {
  try {
    const [connDidA, connDidB] = [viewerDid, targetDid].sort((a, b) => a.localeCompare(b));
    const row = await db.query.connections.findFirst({
      where: (c, { eq, and, isNull }) => and(
        eq(c.didA, connDidA),
        eq(c.didB, connDidB),
        isNull(c.disconnectedAt)
      ),
    });
    return !!row;
  } catch { return false; }
}

export async function getProfile(handle: string): Promise<ProfileData | null> {
  const row = await db.query.profiles.findFirst({
    where: (profiles, { eq, or }) => or(eq(profiles.did, handle), eq(profiles.handle, handle)),
  });
  return row as unknown as ProfileData | null;
}

export async function getProfileCounts(profileDid: string): Promise<ProfileCounts> {
  try {
    const [followersResult] = await db.select({ count: count() }).from(follows).where(eq(follows.followedDid, profileDid));
    const [followingResult] = await db.select({ count: count() }).from(follows).where(eq(follows.followerDid, profileDid));
    const sql = getClient();
    const [connectionsResult] = await sql`
      SELECT count(*)::int as count
      FROM connections.connections
      WHERE (did_a = ${profileDid} OR did_b = ${profileDid})
        AND disconnected_at IS NULL
    `;
    return {
      followers: Number(followersResult.count),
      following: Number(followingResult.count),
      connections: connectionsResult?.count ?? 0,
    };
  } catch { return { followers: 0, following: 0, connections: 0 }; }
}

export async function getFollowStatus(viewerDid: string, targetDid: string): Promise<boolean> {
  const existingFollow = await db.query.follows.findFirst({
    where: (follows, { eq, and }) => and(eq(follows.followerDid, viewerDid), eq(follows.followedDid, targetDid)),
  });
  return !!existingFollow;
}

export async function getLinks(linksHandle: string): Promise<LinkItem[]> {
  const linksServiceUrl = process.env.LINKS_SERVICE_URL;
  if (!linksServiceUrl) return [];
  try {
    const res = await fetch(
      `${linksServiceUrl}/api/pages/${encodeURIComponent(linksHandle)}/links`,
      { cache: 'no-store' }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data.links || []);
  } catch { return []; }
}

export async function getIdentityInfo(did: string): Promise<IdentityInfo> {
  const authSql = getClient();
  const [identityRow] = await authSql`SELECT tier, scope, subtype FROM auth.identities WHERE id = ${did} LIMIT 1`.catch(() => []);
  const [chainRow] = await authSql`SELECT did FROM auth.identity_chains WHERE did = ${did} LIMIT 1`.catch(() => []);
  return {
    scope: (identityRow?.scope ?? 'actor') as IdentityInfo['scope'],
    subtype: identityRow?.subtype ?? null,
    tier: identityRow?.tier ?? '',
    chainVerified: !!chainRow,
  };
}

export async function getMembersByRole(identityDid: string): Promise<MemberEntry[]> {
  try {
    const rows = await db
      .select({
        role: identityMembers.role,
        memberDid: identityMembers.memberDid,
        displayName: profiles.displayName,
        handle: profiles.handle,
        avatar: profiles.avatar,
      })
      .from(identityMembers)
      .leftJoin(profiles, eq(profiles.did, identityMembers.memberDid))
      .where(
        and(
          eq(identityMembers.identityDid, identityDid),
          isNull(identityMembers.removedAt)
        )
      );
    return rows.map((r) => ({
      role: r.role,
      did: r.memberDid,
      displayName: r.displayName ?? r.memberDid,
      handle: r.handle ?? undefined,
      avatar: r.avatar ?? undefined,
    }));
  } catch {
    return [];
  }
}

export interface ForestConfigData {
  enabledServices: string[];
  landingService: string | null;
}

export async function getForestConfig(groupDid: string): Promise<ForestConfigData | null> {
  try {
    const [config] = await db
      .select({
        enabledServices: forestConfig.enabledServices,
        landingService: forestConfig.landingService,
      })
      .from(forestConfig)
      .where(eq(forestConfig.groupDid, groupDid))
      .limit(1);
    return config ?? null;
  } catch {
    return null;
  }
}

export async function getViewerMembership(identityDid: string, viewerDid: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ role: identityMembers.role })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, identityDid),
          eq(identityMembers.memberDid, viewerDid),
          isNull(identityMembers.removedAt)
        )
      )
      .limit(1);
    return row?.role ?? null;
  } catch {
    return null;
  }
}

export async function getMaintainerInfo(identityDid: string, viewerDid: string | null): Promise<{ count: number; isMaintainer: boolean }> {
  try {
    const [{ value: mc }] = await db
      .select({ value: count() })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, identityDid),
          eq(identityMembers.role, 'maintainer'),
          isNull(identityMembers.removedAt)
        )
      );
    let isMaintainer = false;
    if (viewerDid) {
      const [maintainerRow] = await db
        .select({ identityDid: identityMembers.identityDid })
        .from(identityMembers)
        .where(
          and(
            eq(identityMembers.identityDid, identityDid),
            eq(identityMembers.memberDid, viewerDid),
            eq(identityMembers.role, 'maintainer'),
            isNull(identityMembers.removedAt)
          )
        )
        .limit(1);
      isMaintainer = !!maintainerRow;
    }
    return { count: mc, isMaintainer };
  } catch {
    return { count: 0, isMaintainer: false };
  }
}
