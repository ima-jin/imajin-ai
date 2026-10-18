import { SERVICES } from '@imajin/config';
import { OwnershipError } from './ownership-policy';

/** Actual app services, including auth and internal kernel surfaces, not links or daemons. */
export const MEMBER_SERVICES = SERVICES.filter(
  (service) => service.category !== 'meta' && service.category !== 'infrastructure',
);

/** null grants full access; an explicit empty list must never silently broaden authority. */
export function parseMemberServices(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new OwnershipError('Pick at least one service, or choose All services (null)', 400);
  }
  if (!value.every((name) => typeof name === 'string'
    && MEMBER_SERVICES.some((service) => service.name === name))) {
    throw new OwnershipError('allowedServices must contain only known service names', 400);
  }
  return [...new Set(value as string[])].sort((a, b) => a.localeCompare(b));
}
