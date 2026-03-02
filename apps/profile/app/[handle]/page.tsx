import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Avatar } from '../components/Avatar';

interface PageProps {
  params: Promise<{ handle: string }>;
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
  identityTier?: 'soft' | 'hard';
  createdAt: string;
  metadata?: {
    links?: string;
    coffee?: string;
  };
}

async function getViewerDid(): Promise<string | null> {
  const authUrl = process.env.AUTH_SERVICE_URL;
  if (!authUrl) return null;
  try {
    const cookieStore = await cookies();
    const session = cookieStore.get('imajin_session');
    if (!session?.value) return null;
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `imajin_session=${session.value}` },
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
    const session = cookieStore.get('imajin_session');
    const res = await fetch(`${connectionsUrl}/api/connections`, {
      headers: session?.value ? { Cookie: `imajin_session=${session.value}` } : {},
    });
    if (!res.ok) return false;
    const data = await res.json();
    return (data.connections || []).some((c: any) => c.did === targetDid);
  } catch { return false; }
}

async function getProfile(handle: string): Promise<Profile | null> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3005';
  
  try {
    const response = await fetch(`${baseUrl}/api/profile/${handle}`, {
      cache: 'no-store',
    });
    
    if (!response.ok) {
      return null;
    }
    
    return response.json();
  } catch (error) {
    console.error('Failed to fetch profile:', error);
    return null;
  }
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
                href={`${process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://'}profile.${process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}/login`}
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

  const isSoftDID = profile.identityTier === 'soft' || profile.did.startsWith('did:email:');

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
        </div>

        {/* Bio */}
        {profile.bio && (
          <p className="text-gray-300 mb-6">
            {profile.bio}
          </p>
        )}

        {/* Upgrade CTA for soft DID users viewing their own profile */}
        {isSoftDID && isSelf && (
          <div className="mb-6 bg-gradient-to-r from-amber-900/20 to-orange-900/20 border border-amber-700/50 rounded-lg p-4">
            <p className="text-sm text-amber-200 mb-3">
              <strong>🔐 Upgrade to Full Profile</strong>
            </p>
            <p className="text-xs text-gray-400 mb-3">
              Get a permanent identity with cryptographic keys, claim a custom handle, and unlock all Imajin features.
            </p>
            <a
              href={`${process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://'}profile.${process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}/register`}
              className="inline-block px-4 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-medium text-sm"
            >
              Upgrade Now
            </a>
          </div>
        )}

        {/* Contact Info (only visible to self/connections — API strips for others) */}
        {(profile.email || profile.phone) && (
          <div className="mb-6 bg-gray-900/50 border border-gray-800 rounded-lg p-4 text-left">
            <p className="text-xs text-gray-500 mb-2 text-center">📇 Contact</p>
            {profile.email && (
              <p className="text-sm text-gray-300 mb-1">
                <span className="text-gray-500">✉️</span>{' '}
                <a href={`mailto:${profile.email}`} className="text-[#F59E0B] hover:underline">
                  {profile.email}
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

        {/* Links */}
        <div className="flex justify-center gap-4 mb-6">
          {profile.metadata?.links && (
            <a
              href={`${process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://'}links.${process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}/${profile.metadata.links}`}
              className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition text-white"
            >
              🔗 Links
            </a>
          )}
          {profile.metadata?.coffee && (
            <a
              href={`${process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://'}coffee.${process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}/${profile.metadata.coffee}`}
              className="px-4 py-2 bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-[#F59E0B] rounded-lg hover:bg-[#F59E0B]/20 transition"
            >
              ☕ Tip Me
            </a>
          )}
        </div>

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
