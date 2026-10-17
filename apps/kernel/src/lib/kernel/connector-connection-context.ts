import { AsyncLocalStorage } from 'node:async_hooks';
import { connectionSlot } from './connection-slots';

interface ConnectionContext {
  provider: string;
  ownerDid: string;
  slot: string;
}

const context = new AsyncLocalStorage<ConnectionContext>();

/** Provider + owner binding prevents a nested connector call from borrowing another grant. */
export function currentConnectionSlot(provider: string, ownerDid: string): string {
  const selected = context.getStore();
  return selected?.provider === provider && selected.ownerDid === ownerDid ? selected.slot : 'primary';
}

export function withConnectorConnection<T>(
  provider: string,
  ownerDid: string,
  slot: string,
  run: () => T,
): T {
  return context.run({ provider, ownerDid, slot: connectionSlot(slot) }, run);
}
