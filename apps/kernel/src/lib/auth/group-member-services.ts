import { resolveAppDirectoryForIdentity } from '@/src/lib/kernel/app-nav';
import { MEMBER_SERVICES, parseMemberServices, type MemberServiceOption } from './member-service-scope';

/** Resolve registry-only names against the same identity-scoped directory the picker uses. */
export async function parseGroupMemberServices(groupDid: string, value: unknown): Promise<string[] | null> {
  let registryServices: MemberServiceOption[] = [];
  if (Array.isArray(value) && value.some((name) => typeof name === 'string'
    && !MEMBER_SERVICES.some((service) => service.name === name))) {
    const directory = await resolveAppDirectoryForIdentity(groupDid);
    registryServices = directory.filter((app) => app.available).map((app) => ({
      name: app.slug, label: app.name,
    }));
  }
  return parseMemberServices(value, registryServices);
}
