import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, forestConfig, identities, identityMembers, profiles } from '@/src/db';
import { resolveEnabledApps } from '@/src/lib/profile/feature-toggles-compat';

/** Materialize legacy-only membership once; an explicit list always wins. */
export function updateAppSlugs(current: readonly string[], slug: string, added: boolean): string[] {
  const next = new Set(current);
  if (added) next.add(slug);
  else next.delete(slug);
  return [...next];
}

/** Shared by consent and directory writes so parallel app additions cannot overwrite each other. */
export async function setPersonAppMembership(did: string, slug: string, added: boolean): Promise<void> {
  const lockKey = `app-membership:${did}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const [profile] = await tx.select({ featureToggles: profiles.featureToggles })
      .from(profiles).where(eq(profiles.did, did)).limit(1).for('update');
    const featureToggles = {
      ...profile?.featureToggles,
      enabledApps: updateAppSlugs(resolveEnabledApps(profile?.featureToggles), slug, added),
    };
    const [identity] = await tx.select({ name: identities.name })
      .from(identities).where(eq(identities.id, did)).limit(1);
    await tx.insert(profiles).values({
      did, displayName: identity?.name ?? did, featureToggles,
    }).onConflictDoUpdate({
      target: profiles.did,
      set: {
        featureToggles: sql`${profiles.featureToggles} || ${JSON.stringify({ enabledApps: featureToggles.enabledApps })}::jsonb`,
        updatedAt: new Date(),
      },
    });
  });
}

/** Consent belongs to the real person issuing the grant, never an acting-for group. */
export async function addConsentedApp(did: string, slug: string | null): Promise<void> {
  if (slug) await setPersonAppMembership(did, slug, true);
}

export async function canManageGroupApps(groupDid: string, callerDid: string): Promise<boolean> {
  const [membership] = await db.select({ role: identityMembers.role }).from(identityMembers).where(and(
    eq(identityMembers.identityDid, groupDid),
    eq(identityMembers.memberDid, callerDid),
    isNull(identityMembers.removedAt),
  )).limit(1);
  return membership?.role === 'owner' || membership?.role === 'admin';
}

/** Groups keep their existing explicit forest_config storage, including unrelated services. */
export async function setGroupAppMembership(did: string, slug: string, added: boolean): Promise<void> {
  const lockKey = `app-membership:${did}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const [config] = await tx.select({
      enabledServices: forestConfig.enabledServices,
      landingService: forestConfig.landingService,
    }).from(forestConfig).where(eq(forestConfig.groupDid, did)).limit(1);
    const enabledServices = updateAppSlugs(config?.enabledServices ?? [], slug, added);
    const landingService = !added && config?.landingService === slug ? null : config?.landingService;
    await tx.insert(forestConfig).values({ groupDid: did, enabledServices, landingService })
      .onConflictDoUpdate({
        target: forestConfig.groupDid,
        set: { enabledServices, landingService, updatedAt: new Date() },
      });
  });
}
