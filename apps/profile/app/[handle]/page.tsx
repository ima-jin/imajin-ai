import { notFound } from 'next/navigation';
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
  displayType: 'human' | 'agent' | 'device' | 'org' | 'event' | 'service';
  bio?: string;
  avatar?: string;
  createdAt: string;
  metadata?: {
    links?: string;
    coffee?: string;
  };
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
  
  const typeEmoji: Record<Profile['displayType'], string> = {
    human: '👤',
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

  const typeLabels: Record<Profile['displayType'], string> = {
    human: '👤 Human',
    agent: '🤖 Agent',
    device: '📱 Device',
    org: '🏢 Organization',
    event: '📅 Event',
    service: '⚙️ Service',
  };
  const typeLabel = typeLabels[profile.displayType];

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

        {/* Type badge */}
        <span className="inline-block px-3 py-1 bg-gray-900 border border-gray-800 rounded-full text-sm mb-4 text-gray-300">
          {typeLabel}
        </span>

        {/* Bio */}
        {profile.bio && (
          <p className="text-gray-300 mb-6">
            {profile.bio}
          </p>
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
