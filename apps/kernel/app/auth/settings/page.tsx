import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { db, identities, identityMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import IdentitySettingsPanel from '../components/IdentitySettingsPanel';

export default async function SettingsPage() {
  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(cookieConfig.name)?.value;

  let sessionDid: string | null = null;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    sessionDid = session?.sub ?? null;
  }

  if (!sessionDid) {
    redirect('/auth');
  }

  const actingAs = cookieStore.get('x-acting-as')?.value || null;
  const effectiveDid = actingAs || sessionDid;

  const [identity] = await db
    .select({ scope: identities.scope })
    .from(identities)
    .where(eq(identities.id, effectiveDid))
    .limit(1);

  // Actor scope: show link to security settings
  if (!identity || identity.scope === 'actor') {
    return (
      <div className="space-y-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-white mb-1">Security</h2>
          <p className="text-sm text-zinc-400 mb-4">Manage your account security settings.</p>
          <Link
            href="/auth/settings/security"
            className="inline-block px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
          >
            Security settings →
          </Link>
        </div>
      </div>
    );
  }

  // Non-actor: check admin/owner access
  const [membership] = await db
    .select({ role: identityMembers.role })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, effectiveDid),
        eq(identityMembers.memberDid, sessionDid),
        isNull(identityMembers.removedAt)
      )
    )
    .limit(1);

  if (membership?.role !== 'owner' && membership?.role !== 'admin') {
    return (
      <div className="text-zinc-500 text-sm py-8">
        You need owner or admin access to manage settings for this identity.
      </div>
    );
  }

  return <IdentitySettingsPanel groupDid={effectiveDid} />;
}
