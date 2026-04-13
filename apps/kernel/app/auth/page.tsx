import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import IdentitySwitcher from './components/IdentitySwitcher';
import IdentityDetail from './components/IdentityDetail';
import AttestationList from './components/AttestationList';
import PlacesMaintained from './components/PlacesMaintained';

interface SearchParams {
  type?: string;
  role?: string;
  page?: string;
}

export default async function AuthPage({ searchParams }: { searchParams: SearchParams }) {
  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(cookieConfig.name)?.value;

  let sessionDid: string | null = null;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    sessionDid = session?.sub ?? null;
  }

  // Unauthenticated view
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

  // Fetch personal identity info for the switcher
  const [personalIdentity] = await db
    .select({ name: identities.name, handle: identities.handle })
    .from(identities)
    .where(eq(identities.id, sessionDid))
    .limit(1);

  const personalName = personalIdentity?.name ?? null;
  const personalHandle = personalIdentity?.handle ?? null;

  // Effective DID: actingAs cookie OR personal DID
  const actingAs = cookieStore.get('x-acting-as')?.value || null;
  const effectiveDid = actingAs || sessionDid;

  // Auth URL for the useIdentities hook (same-origin relative path)
  const authUrl = '/auth';
  const profileUrl = process.env.NEXT_PUBLIC_PROFILE_URL ?? '';

  return (
    <div className="flex flex-col lg:flex-row gap-6 min-h-[calc(100vh-4rem)]">
      {/* Left rail (desktop) / Top section (mobile) */}
      <div className="lg:w-72 lg:shrink-0">
        <div className="sticky top-6 bg-[#0a0a0a] border border-gray-800 rounded-2xl p-4">
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3 px-1">
            Identities
          </h2>
          <IdentitySwitcher
            authUrl={authUrl}
            profileUrl={profileUrl}
            personalDid={sessionDid}
            personalName={personalName}
            personalHandle={personalHandle}
          />
          <PlacesMaintained sessionDid={sessionDid} />
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 min-w-0 space-y-6">
        <IdentityDetail did={effectiveDid} />
        <AttestationList sessionDid={effectiveDid} searchParams={searchParams} />
      </div>
    </div>
  );
}
