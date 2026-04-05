import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { SESSION_COOKIE_NAME } from '@imajin/config';
import { db, profiles, follows } from '@/db';
import { getClient } from '@imajin/db';
import { eq, count } from 'drizzle-orm';
import { Avatar } from '../components/Avatar';
import { FollowButton } from '../components/FollowButton';
import { AskButton } from '../components/AskButton';
import { MarketItems } from '../components/MarketItems';
import { UpcomingEvents } from '../components/UpcomingEvents';

interface PageProps {
  params: Promise<{ handle: string }>;
}

interface FeatureToggles {
  inference_enabled?: boolean;
  show_market_items?: boolean;
  show_events?: boolean;
  links?: string | null;
  coffee?: string | null;
  dykil?: string | null;
  learn?: string | null;
}

interface Profile {
  did: string;
  handle?: string;
  displayName: string;
  displayType: 'human' | 'presence' | 'agent' | 'device' | 'org' | 'event' | 'service';
  bio?: string;
  avatar?: string;
  email?: string;
  phone?: string;
  contactEmail?: string;
  featureToggles?: FeatureToggles;
  createdAt: string;
  metadata?: Record<string, string>;
}

interface ProfileCounts {
  followers: number;
  following: number;
  connections: number;
}

interface LinkItem {
  title: string;
  url: string;
  description?: string;
}

async function getViewerDid(): Promise<string | null> {
  const authUrl = process.env.AUTH_SERVICE_URL;
  if (!authUrl) return null;
  try {
    const cookieStore = await cookies();
    const session = cookieStore.get(SESSION_COOKIE_NAME);
    if (!session?.value) return null;
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.value}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || data.identity?.did || null;
  } catch { return null; }
}

async function isConnected(viewerDid: string, targetDid: string): Promise<boolean> {
  const connectionsUrl = process.env.CONNECTIONS_SERVICE_URL;
  if (!connectionsUrl) return false;
  try {
    const cookieStore = await cookies();
    const session = cookieStore.get(SESSION_COOKIE_NAME);
    const res = await fetch(`${connectionsUrl}/api/connections`, {
      headers: session?.value ? { Cookie: `${SESSION_COOKIE_NAME}=${session.value}` } : {},
    });
    if (!res.ok) return false;
    const data = await res.json();
    return (data.connections || []).some((c: any) => c.did === targetDid);
  } catch { return false; }
}

async function getProfile(handle: string): Promise<Profile | null> {
  const row = await db.query.profiles.findFirst({
    where: (profiles, { eq, or }) => or(eq(profiles.did, handle), eq(profiles.handle, handle)),
  });
  return row as unknown as Profile | null;
}

async function getProfileCounts(profileDid: string): Promise<ProfileCounts> {
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

async function getFollowStatus(viewerDid: string, targetDid: string): Promise<boolean> {
  const existingFollow = await db.query.follows.findFirst({
    where: (follows, { eq, and }) => and(eq(follows.followerDid, viewerDid), eq(follows.followedDid, targetDid)),
  });
  return !!existingFollow;
}

async function getLinks(linksHandle: string): Promise<LinkItem[]> {
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

// Generate dynamic metadata for OG/Twitter cards
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { handle } = await params;
  const profile = await getProfile(handle);

  if (!profile) {
    return {
      title: 'Profile Not Found',
    };
  }

  const typeEmoji: Record<string, string> = {
    human: '👤',
    presence: '🟠',
    agent: '🤖',
    device: '📱',
    org: '🏢',
    event: '📅',
    service: '⚙️',
  };

  const displayHandle = profile.handle ? `@${profile.handle}` : handle;
  const description = profile.bio
    ? profile.bio.slice(0, 200) + (profile.bio.length > 200 ? '...' : '')
    : `${typeEmoji[profile.displayType]} ${profile.displayType} on the Imajin network`;

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://profile.imajin.ai';
  const url = `${baseUrl}/${handle}`;

  return {
    title: `${profile.displayName} (${displayHandle})`,
    description,
    openGraph: {
      title: `${profile.displayName} ${typeEmoji[profile.displayType]}`,
      description,
      url,
      siteName: 'Imajin Profiles',
      type: 'profile',
      images: profile.avatar?.startsWith('http') ? [{ url: profile.avatar }] : undefined,
    },
    twitter: {
      card: profile.avatar?.startsWith('http') ? 'summary_large_image' : 'summary',
      title: `${profile.displayName} ${typeEmoji[profile.displayType]}`,
      description,
      images: profile.avatar?.startsWith('http') ? [profile.avatar] : undefined,
    },
  };
}

export default async function ProfilePage({ params }: PageProps) {
  const { handle } = await params;
  const profile = await getProfile(handle);

  if (!profile) {
    notFound();
  }

  // Trust gating: only show full profile to self or connections
  const viewerDid = await getViewerDid();
  const isSelf = viewerDid === profile.did;
  const connected = viewerDid && !isSelf ? await isConnected(viewerDid, profile.did) : false;

  if (!isSelf && !connected) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <div className="mb-4 flex justify-center">
            <Avatar avatar={profile.avatar} displayName={profile.displayName} size="lg" />
          </div>
          <h1 className="text-2xl font-bold mb-1 text-white">{profile.displayName}</h1>
          {profile.handle && <p className="text-gray-400 mb-4">@{profile.handle}</p>}
          <div className="py-6 border-t border-gray-800 mt-4">
            <p className="text-gray-500 text-sm">
              🔒 This profile is only visible to connections.
            </p>
            {!viewerDid && (
              <a
                href={`${process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://'}auth.${process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}/login`}
                className="inline-block mt-4 px-6 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-medium text-sm"
              >
                Login to see more
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  const typeLabels: Record<string, string> = {
    human: '👤 Human',
    presence: '🟠 Presence',
    agent: '🤖 Agent',
    device: '📱 Device',
    org: '🏢 Organization',
    event: '📅 Event',
    service: '⚙️ Service',
  };
  const typeLabel = typeLabels[profile.displayType];

  const authSql = getClient();
  const [identityRow] = await authSql`SELECT tier FROM auth.identities WHERE id = ${profile.did} LIMIT 1`.catch(() => []);
  const isSoftDID = identityRow?.tier === 'soft';
  const [chainRow] = await authSql`SELECT did FROM auth.identity_chains WHERE did = ${profile.did} LIMIT 1`.catch(() => []);
  const chainVerified = !!chainRow;

  // Fetch counts, follow status, and links in parallel
  const [counts, isFollowing, links] = await Promise.all([
    getProfileCounts(profile.did),
    viewerDid && !isSelf ? getFollowStatus(viewerDid, profile.did) : Promise.resolve(false),
    profile.featureToggles?.links ? getLinks(profile.featureToggles.links) : Promise.resolve([]),
  ]);

  const servicePrefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
  const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8 text-center">
        {/* Avatar */}
        <div className="mb-4 flex justify-center">
          <Avatar avatar={profile.avatar} displayName={profile.displayName} size="lg" />
        </div>

        {/* Name & Handle */}
        <h1 className="text-2xl font-bold mb-1 text-white">{profile.displayName}</h1>
        {profile.handle && (
          <p className="text-gray-400 mb-2">@{profile.handle}</p>
        )}

        {/* Type badge & Identity Tier */}
        <div className="flex gap-2 justify-center mb-4">
          <span className="inline-block px-3 py-1 bg-gray-900 border border-gray-800 rounded-full text-sm text-gray-300">
            {typeLabel}
          </span>
          {isSoftDID && (
            <span className="inline-block px-3 py-1 bg-amber-900/30 border border-amber-700/50 rounded-full text-sm text-amber-400">
              ⚡ Quick Profile
            </span>
          )}
          {chainVerified && (
            <span className="inline-block px-3 py-1 bg-emerald-900/30 border border-emerald-700/50 rounded-full text-sm text-emerald-400">
              ⛓ Chain Verified
            </span>
          )}
        </div>

        {/* Counts & Follow Button */}
        <div className="mb-6 flex flex-col items-center gap-3">
          <p className="text-sm text-gray-400">
            <span className="text-white font-medium">{counts.followers}</span> followers
            {' · '}
            <span className="text-white font-medium">{counts.following}</span> following
            {' · '}
            <span className="text-white font-medium">{counts.connections}</span> connections
          </p>
          {viewerDid && !isSelf && (
            <FollowButton targetDid={profile.did} initialFollowing={isFollowing} />
          )}
        </div>

        {/* Bio */}
        {profile.bio && (
          <p className="text-gray-300 mb-6">
            {profile.bio}
          </p>
        )}

        {/* Info note for invited members viewing their own profile */}
        {isSoftDID && isSelf && (
          <p className="mb-6 text-xs text-gray-500 border border-gray-800 rounded-lg px-4 py-3">
            Invited members can claim a handle and download backup keys
          </p>
        )}

        {/* Contact Info (only visible to self/connections — API strips for others) */}
        {(profile.contactEmail || profile.phone) && (
          <div className="mb-6 bg-gray-900/50 border border-gray-800 rounded-lg p-4 text-left">
            <p className="text-xs text-gray-500 mb-2 text-center">📇 Contact</p>
            {profile.contactEmail && (
              <p className="text-sm text-gray-300 mb-1">
                <span className="text-gray-500">✉️</span>{' '}
                <a href={`mailto:${profile.contactEmail}`} className="text-[#F59E0B] hover:underline">
                  {profile.contactEmail}
                </a>
              </p>
            )}
            {profile.phone && (
              <p className="text-sm text-gray-300">
                <span className="text-gray-500">📱</span>{' '}
                <a href={`tel:${profile.phone}`} className="text-[#F59E0B] hover:underline">
                  {profile.phone}
                </a>
              </p>
            )}
          </div>
        )}

        {/* Action buttons — single row */}
        <div className="flex justify-center gap-3 mb-6 flex-wrap">
          <AskButton
            targetDid={profile.did}
            targetName={profile.displayName}
            targetHandle={profile.handle}
            inferenceEnabled={!!profile.featureToggles?.inference_enabled}
            canAsk={!!viewerDid}
          />
          {profile.featureToggles?.links && (
            <a
              href={`${servicePrefix}links.${domain}/${profile.featureToggles.links}`}
              className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition text-white text-sm font-medium"
            >
              🔗 Links
            </a>
          )}
          {profile.featureToggles?.coffee && (
            <a
              href={`${servicePrefix}coffee.${domain}/${profile.featureToggles.coffee}`}
              className="px-4 py-2 bg-[#F59E0B]/10 border-[#F59E0B]/30 text-[#F59E0B] rounded-lg hover:bg-[#F59E0B]/20 transition border text-sm font-medium"
            >
              ☕ Tip Me
            </a>
          )}
        </div>

        {/* Expanded links list (when links service has items) */}
        {links.length > 0 && (
          <div className="mb-6 space-y-2">
            {links.map((link, i) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-4 py-3 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition text-left"
              >
                <p className="text-white text-sm font-medium">{link.title}</p>
                {link.description && (
                  <p className="text-gray-500 text-xs mt-0.5">{link.description}</p>
                )}
              </a>
            ))}
          </div>
        )}

        {/* Upcoming events */}
        {profile.featureToggles?.show_events && (
          <UpcomingEvents did={profile.did} servicePrefix={servicePrefix} domain={domain} viewerDid={viewerDid} />
        )}

        {/* Market items */}
        {profile.featureToggles?.show_market_items && (
          <MarketItems did={profile.did} handle={profile.handle} servicePrefix={servicePrefix} domain={domain} />
        )}

        {/* Member since */}
        <p className="text-xs text-gray-500 mt-4">
          Member since {new Date(profile.createdAt).toLocaleDateString('en-US', {
            month: 'long',
            year: 'numeric'
          })}
        </p>
      </div>

      {/* DID */}
      <p className="text-center text-xs text-gray-500 mt-4 font-mono break-all">
        {profile.did}
      </p>
    </div>
  );
}
