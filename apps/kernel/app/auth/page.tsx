import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { db, profiles } from '@/src/db';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import Image from 'next/image';

export default async function AuthPage() {
  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(cookieConfig.name)?.value;

  let sessionDid: string | null = null;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    sessionDid = session?.sub ?? null;
  }

  if (!sessionDid) {
    return (
      <div className="max-w-2xl mx-auto text-center py-20">
        <div className="text-6xl mb-4">🔏</div>
        <h1 className="text-3xl font-bold text-white mb-3">Identity Hub</h1>
        <p className="text-zinc-400 mb-8">
          Sign in to manage your identities and browse attestations.
        </p>
        <Link
          href="/auth/login"
          className="inline-block px-6 py-3 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors"
        >
          Sign in
        </Link>
      </div>
    );
  }

  // Effective DID: actingAs cookie OR personal DID
  const actingAs = cookieStore.get('x-acting-as')?.value || null;
  const effectiveDid = actingAs || sessionDid;

  // Fetch profile data
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.did, effectiveDid))
    .limit(1);

  if (!profile) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
        <p className="text-zinc-400 text-sm">No profile found for this identity.</p>
        <Link
          href="/profile/edit"
          className="inline-block mt-3 text-sm text-amber-400 hover:text-amber-300 transition-colors"
        >
          Create profile →
        </Link>
      </div>
    );
  }

  const metadata = (profile.metadata ?? {}) as Record<string, unknown>;
  const location = metadata.location as string | undefined;
  const website = metadata.website as string | undefined;

  const mediaUrl = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';

  // Resolve avatar URL
  let avatarSrc: string | null = null;
  if (profile.avatarAssetId && mediaUrl) {
    avatarSrc = `${mediaUrl}/api/media/${profile.avatarAssetId}`;
  } else if (profile.avatar && (profile.avatar.startsWith('http') || profile.avatar.startsWith('/'))) {
    avatarSrc = profile.avatar;
  }

  return (
    <div className="space-y-4">
      {/* Banner */}
      {profile.banner && (
        <div className="relative h-32 rounded-xl overflow-hidden bg-zinc-800">
          <Image
            src={profile.bannerAssetId && mediaUrl ? `${mediaUrl}/api/media/${profile.bannerAssetId}` : profile.banner}
            alt=""
            fill
            className="object-cover"
          />
        </div>
      )}

      {/* Profile info */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-4">
        <div className="flex items-start gap-4">
          {/* Avatar */}
          {avatarSrc ? (
            <div className="relative w-16 h-16 rounded-full overflow-hidden bg-zinc-800 shrink-0">
              <Image src={avatarSrc} alt="" fill className="object-cover" />
            </div>
          ) : profile.avatar ? (
            <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center text-2xl shrink-0">
              {profile.avatar}
            </div>
          ) : null}

          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white">{profile.displayName}</h2>
            {profile.handle && (
              <p className="text-sm text-zinc-400">@{profile.handle}</p>
            )}
          </div>
        </div>

        {/* Bio */}
        {profile.bio && (
          <p className="text-sm text-zinc-300 leading-relaxed">{profile.bio}</p>
        )}

        {/* Details */}
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-400">
          {location && (
            <span className="flex items-center gap-1.5">
              <span className="text-zinc-600">📍</span> {location}
            </span>
          )}
          {website && (
            <a
              href={website.startsWith('http') ? website : `https://${website}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-amber-400 transition-colors"
            >
              <span className="text-zinc-600">🔗</span> {website.replace(/^https?:\/\//, '')}
            </a>
          )}
          {profile.contactEmail && (
            <span className="flex items-center gap-1.5">
              <span className="text-zinc-600">✉️</span> {profile.contactEmail}
            </span>
          )}
          {profile.phone && (
            <span className="flex items-center gap-1.5">
              <span className="text-zinc-600">📞</span> {profile.phone}
            </span>
          )}
        </div>

        {/* Visibility badge */}
        {profile.visibility === 'incognito' && (
          <span className="inline-block text-xs px-2 py-1 rounded-full bg-zinc-800 text-zinc-500 border border-zinc-700">
            Incognito
          </span>
        )}
      </div>
    </div>
  );
}
