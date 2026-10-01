import { db, identities, identityMembers, forestConfig } from '@/src/db';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import { eq, and, isNull } from 'drizzle-orm';
import IdentitySwitcher from './components/IdentitySwitcher';
import IdentityDetail from './components/IdentityDetail';
import PlacesMaintained from './components/PlacesMaintained';
import IdentityTabBar from './components/IdentityTabBar';
import AuthLayoutShell from './components/AuthLayoutShell';
import { buildPublicUrl } from '@imajin/config';
import { resolveNavAppsForIdentity, filterByPlacement } from '@/src/lib/kernel/app-nav';

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
  // Money (#2211) is the business-DID receivable surface — not a
  // toggleable vertical service (unlike enabledServices below), so it's
  // gated on scope alone, the same way Security is gated on 'actor'.
  const showMoney = effectiveIdentity?.scope === 'business';
  // Tax registrations (#2420) live next to Money and share the same gate.
  const showTax = effectiveIdentity?.scope === 'business';

  // Query forest_config for enabled services and landing service. Kept
  // separately from the registry-driven `navApps` below: Pay/Media are
  // kernel-native services (never pruned, see
  // `apps/kernel/app/auth/lib/service-registry.ts`'s `isKernelNativeService`)
  // and are gated on this raw toggle list directly, exactly as before #2425.
  let rawEnabledServices: string[] = [];
  let landingService: string | null = null;
  const isActorScope = !effectiveIdentity?.scope || effectiveIdentity.scope === 'actor';

  if (!isActorScope) {
    const [forestRow] = await db
      .select({ enabledServices: forestConfig.enabledServices, landingService: forestConfig.landingService })
      .from(forestConfig)
      .where(eq(forestConfig.groupDid, did))
      .limit(1);
    rawEnabledServices = forestRow?.enabledServices ?? [];
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
  }

  const showPay = isActorScope || rawEnabledServices.includes('pay');
  const showMedia = isActorScope || rawEnabledServices.includes('media');

  // Registry-driven nav apps (#2425) — replaces the old hard-coded
  // actor-scope fallback list. `resolveNavAppsForIdentity` resolves the
  // enabled set itself: non-actor scopes from forest_config (as above), actors
  // from their own feature_toggles (#2434 — #2425 ruling b; an actor that
  // never configured toggles still sees every app). The six extractable app
  // slugs (coffee/dykil/links/learn/events/market) come from `registry.apps`.
  const navApps = filterByPlacement(await resolveNavAppsForIdentity(did), 'auth-submenu');

  const authUrl = '/auth';
  const profileUrl = buildPublicUrl('profile');

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
      showMoney={showMoney}
      showTax={showTax}
      showPay={showPay}
      showMedia={showMedia}
      apps={navApps}
    />
  );

  return (
    <AuthLayoutShell leftRail={leftRail} identityDetail={identityDetail} tabBar={tabBar} landingService={landingService}>
      {children}
    </AuthLayoutShell>
  );
}
