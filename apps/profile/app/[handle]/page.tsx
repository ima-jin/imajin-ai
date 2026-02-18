import { notFound } from 'next/navigation';
import Link from 'next/link';

interface PageProps {
  params: { handle: string };
}

interface Profile {
  did: string;
  handle?: string;
  displayName: string;
  displayType: 'human' | 'agent' | 'presence';
  bio?: string;
  avatar?: string;
  invitedBy?: string;
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

export default async function ProfilePage({ params }: PageProps) {
  const profile = await getProfile(params.handle);
  
  if (!profile) {
    notFound();
  }

  const typeLabels: Record<Profile['displayType'], string> = {
    human: '👤 Human',
    agent: '🤖 Agent',
    presence: '🟠 Presence',
  };
  const typeLabel = typeLabels[profile.displayType];

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 text-center">
        {/* Avatar */}
        <div className="mb-4">
          {profile.avatar?.startsWith('http') ? (
            <img 
              src={profile.avatar} 
              alt={profile.displayName}
              className="w-24 h-24 rounded-full mx-auto object-cover"
            />
          ) : (
            <div className="w-24 h-24 rounded-full mx-auto bg-gradient-to-br from-orange-400 to-orange-600 flex items-center justify-center text-4xl">
              {profile.avatar || '👤'}
            </div>
          )}
        </div>

        {/* Name & Handle */}
        <h1 className="text-2xl font-bold mb-1">{profile.displayName}</h1>
        {profile.handle && (
          <p className="text-gray-500 mb-2">@{profile.handle}</p>
        )}
        
        {/* Type badge */}
        <span className="inline-block px-3 py-1 bg-gray-100 dark:bg-gray-700 rounded-full text-sm mb-4">
          {typeLabel}
        </span>

        {/* Bio */}
        {profile.bio && (
          <p className="text-gray-600 dark:text-gray-300 mb-6">
            {profile.bio}
          </p>
        )}

        {/* Links */}
        <div className="flex justify-center gap-4 mb-6">
          {profile.metadata?.links && (
            <a 
              href={`https://links.imajin.ai/${profile.metadata.links}`}
              className="px-4 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition"
            >
              🔗 Links
            </a>
          )}
          {profile.metadata?.coffee && (
            <a 
              href={`https://coffee.imajin.ai/${profile.metadata.coffee}`}
              className="px-4 py-2 bg-orange-100 dark:bg-orange-900 text-orange-600 dark:text-orange-300 rounded-lg hover:bg-orange-200 dark:hover:bg-orange-800 transition"
            >
              ☕ Tip Me
            </a>
          )}
        </div>

        {/* Invited by */}
        {profile.invitedBy && (
          <p className="text-sm text-gray-500">
            Invited by:{' '}
            <Link href={`/${profile.invitedBy}`} className="text-orange-500 hover:underline">
              {profile.invitedBy}
            </Link>
          </p>
        )}

        {/* Member since */}
        <p className="text-xs text-gray-400 mt-4">
          Member since {new Date(profile.createdAt).toLocaleDateString('en-US', { 
            month: 'long', 
            year: 'numeric' 
          })}
        </p>
      </div>

      {/* DID */}
      <p className="text-center text-xs text-gray-400 mt-4 font-mono break-all">
        {profile.did}
      </p>
    </div>
  );
}
