export type LocationType = 'physical' | 'virtual' | 'hybrid';

export function getLocationType(event: { locationType?: string | null; isVirtual?: boolean | null }): LocationType {
  if (event.locationType) return event.locationType as LocationType;
  return event.isVirtual ? 'virtual' : 'physical';
}
