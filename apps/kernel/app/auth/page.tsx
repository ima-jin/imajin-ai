import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import Link from 'next/link';

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

  // Profile tab — IdentityDetail is rendered by the layout above the tabs
  return null;
}
