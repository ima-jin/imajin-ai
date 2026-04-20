import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { db, identities, identityMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import IdentityMembersPanel from '../components/IdentityMembersPanel';

export default async function MembersPage() {
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

  if (!identity || identity.scope === 'actor') {
    return (
      <div className="text-zinc-500 text-sm py-8">
        Members are only available for group identities.
      </div>
    );
  }

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
        You need owner or admin access to manage members for this identity.
      </div>
    );
  }

  return <IdentityMembersPanel groupDid={effectiveDid} />;
}
