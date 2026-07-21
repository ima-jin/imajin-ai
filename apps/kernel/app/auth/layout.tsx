import { db, identities, identityMembers, forestConfig } from '@/src/db';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import { eq, and, isNull } from 'drizzle-orm';
import IdentitySwitcher from './components/IdentitySwitcher';
import IdentityDetail from './components/IdentityDetail';
import PlacesMaintained from './components/PlacesMaintained';
import IdentityTabBar from './components/IdentityTabBar';
import AuthLayoutShell from './components/AuthLayoutShell';

export default async function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { sessionDid, effectiveDid } = await getEffectiveDid();

  // Unauthenticated: just render children (login/register/onboard work normally)
  if (!sessionDid) {
    return <>{children}</>;
  }

  // effectiveDid is non-null whenever sessionDid is non-null
  const did = effectiveDid ?? sessionDid!;

  // Fetch personal identity info for the switcher (always on raw session DID — never delegated)
  const [personalIdentity] = await db
    .select({ name: identities.name, handle: identities.handle })
    .from(identities)
    .where(eq(identities.id, sessionDid))
    .limit(1);

  const personalName = personalIdentity?.name ?? null;
  const personalHandle = personalIdentity?.handle ?? null;

  // Check if Settings/Members tabs should show (non-actor scope + owner/admin role)
  const [effectiveIdentity] = await db
    .select({ scope: identities.scope })
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);

  let showSettings = false;
  let showMembers = false;
  const showSecurity = effectiveIdentity?.scope === 'actor';

  // Query forest_config for enabled services and landing service
  let enabledServices: string[] = [];
  let landingService: string | null = null;

  if (effectiveIdentity?.scope && effectiveIdentity.scope !== 'actor') {
    const [forestRow] = await db
      .select({ enabledServices: forestConfig.enabledServices, landingService: forestConfig.landingService })
      .from(forestConfig)
      .where(eq(forestConfig.groupDid, did))
      .limit(1);
    enabledServices = forestRow?.enabledServices ?? [];
    landingService = forestRow?.landingService ?? null;

    const [membership] = await db
      .select({ role: identityMembers.role })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, did),
          eq(identityMembers.memberDid, sessionDid),
          isNull(identityMembers.removedAt)
        )
      )
      .limit(1);
    if (membership?.role === 'owner' || membership?.role === 'admin') {
      showSettings = true;
      showMembers = true;
    }
  } else {
    // Actor scope: all services visible
    enabledServices = ['events', 'market', 'coffee', 'dykil', 'learn', 'links', 'pay', 'media'];
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

  const identityDetail = <IdentityDetail did={did} sessionDid={sessionDid} />;
  const tabBar = (
    <IdentityTabBar
      showSettings={showSettings}
      showMembers={showMembers}
      showSecurity={showSecurity}
      enabledServices={enabledServices}
      landingService={landingService}
    />
  );

  return (
    <AuthLayoutShell leftRail={leftRail} identityDetail={identityDetail} tabBar={tabBar} landingService={landingService}>
      {children}
    </AuthLayoutShell>
  );
}
