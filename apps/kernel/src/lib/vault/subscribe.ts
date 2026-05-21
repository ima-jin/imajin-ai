import type { VaultEntry } from '@imajin/vault-core';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface VaultSubscription {
  field: string;
  callback: (newEntry: VaultEntry) => void | Promise<void>;
}

const subscriptions = new Map<string, VaultSubscription[]>();

export function subscribeToSecret(
  field: string,
  callback: VaultSubscription['callback']
): () => void {
  const list = subscriptions.get(field) ?? [];
  const sub: VaultSubscription = { field, callback };
  list.push(sub);
  subscriptions.set(field, list);

  log.debug({ field }, 'Vault subscription added');

  return () => {
    const current = subscriptions.get(field) ?? [];
    const filtered = current.filter((s) => s.callback !== callback);
    if (filtered.length === 0) {
      subscriptions.delete(field);
    } else {
      subscriptions.set(field, filtered);
    }
    log.debug({ field }, 'Vault subscription removed');
  };
}

export async function notifySubscribers(field: string, entry: VaultEntry): Promise<void> {
  const list = subscriptions.get(field) ?? [];
  if (list.length === 0) {
    return;
  }

  await Promise.all(
    list.map(async (sub) => {
      try {
        await sub.callback(entry);
      } catch (err) {
        log.error({ err: String(err), field }, 'Vault subscription callback error');
      }
    })
  );
}
