import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { db, identities, identityMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import IdentitySwitcher from './components/IdentitySwitcher';
import IdentityDetail from './components/IdentityDetail';
import PlacesMaintained from './components/PlacesMaintained';
import IdentityTabBar from './components/IdentityTabBar';
import AuthLayoutShell from './components/AuthLayoutShell';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(cookieConfig.name)?.value;

  let sessionDid: string | null = null;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    sessionDid = session?.sub ?? null;
  }

  // Unauthenticated: just render children (login/register/onboard work normally)
  if (!sessionDid) {
    return <>{children}</>;
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

  // Check if Settings/Members tabs should show (non-actor scope + owner/admin role)
  const [effectiveIdentity] = await db
    .select({ scope: identities.scope })
    .from(identities)
    .where(eq(identities.id, effectiveDid))
    .limit(1);

  let showSettings = false;
  let showMembers = false;
  const showSecurity = effectiveIdentity?.scope === 'actor';
  if (effectiveIdentity?.scope && effectiveIdentity.scope !== 'actor') {
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
    if (membership?.role === 'owner' || membership?.role === 'admin') {
      showSettings = true;
      showMembers = true;
    }
  }

  const authUrl = '/auth';
  const profileUrl = process.env.NEXT_PUBLIC_PROFILE_URL ?? '';

  const leftRail = (
    <>
      <IdentitySwitcher
        authUrl={authUrl}
        profileUrl={profileUrl}
        personalDid={sessionDid}
        personalName={personalName}
        personalHandle={personalHandle}
      />
      <PlacesMaintained sessionDid={sessionDid} />
    </>
  );

  const identityDetail = <IdentityDetail did={effectiveDid} sessionDid={sessionDid} />;
  const tabBar = <IdentityTabBar showSettings={showSettings} showMembers={showMembers} showSecurity={showSecurity} />;

  return (
    <AuthLayoutShell leftRail={leftRail} identityDetail={identityDetail} tabBar={tabBar}>
      {children}
    </AuthLayoutShell>
  );
}
