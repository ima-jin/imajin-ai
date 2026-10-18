import { SERVICES } from '@imajin/config';
import { OwnershipError } from './ownership-policy';

/** Actual app services, including auth and internal kernel surfaces, not links or daemons. */
export const MEMBER_SERVICES = SERVICES.filter(
  (service) => service.category !== 'meta' && service.category !== 'infrastructure',
);
export interface MemberServiceOption {
  name: string;
  label: string;
}

/** Preserve registry-only apps and deduplicate apps also present in the static manifest. */
export function memberServiceOptions(registryServices: readonly MemberServiceOption[]): MemberServiceOption[] {
  return [...new Map([...MEMBER_SERVICES, ...registryServices].map((service) => [service.name, service])).values()];
}

/** null grants full access; an explicit empty list must never silently broaden authority. */
export function parseMemberServices(value: unknown, registryServices: readonly MemberServiceOption[] = []): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new OwnershipError('Pick at least one service, or choose All services (null)', 400);
  }
  const services = memberServiceOptions(registryServices);
  if (!value.every((name) => typeof name === 'string'
    && services.some((service) => service.name === name))) {
    throw new OwnershipError('allowedServices must contain only known service names', 400);
  }
  return [...new Set(value as string[])].sort((a, b) => a.localeCompare(b));
}

/** Called under the group lock using live memberships, never session role/scope claims. */
export function assertMemberServiceGrant(
  caller: { role: string; allowedServices: string[] | null },
  services: string[] | null,
  previousServices?: string[] | null,
) {
  if (caller.role === 'owner') return;
  if (services === null) {
    throw new OwnershipError('Only the owner may grant All services', 403);
  }
  if (caller.allowedServices !== null && services.some((service) => !caller.allowedServices?.includes(service))) {
    throw new OwnershipError('Services must be within your own allowed services', 403);
  }
  if (previousServices && services.some((service) => !previousServices.includes(service))) {
    throw new OwnershipError('Only the owner may widen a member’s allowed services', 403);
  }
}
