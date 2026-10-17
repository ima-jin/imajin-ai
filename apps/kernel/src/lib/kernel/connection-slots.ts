/** Client-safe connection-slot identifiers. Org selectors are intentionally not supported yet. */
export const PRIMARY_CONNECTION = 'primary';

export function connectionSlot(value?: string | null): string {
  const slot = value ?? PRIMARY_CONNECTION;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slot)) {
    throw new Error('invalid_connection: use 1–64 lowercase letters, numbers, hyphens or underscores');
  }
  return slot;
}

/** Keep legacy primary vault grants resolving without moving or re-sealing secrets. */
export function connectionVaultField(prefix: string, ownerDid: string, slot?: string): string {
  const selected = connectionSlot(slot);
  return `${prefix}:${ownerDid}${selected === PRIMARY_CONNECTION ? '' : `:${selected}`}`;
}
