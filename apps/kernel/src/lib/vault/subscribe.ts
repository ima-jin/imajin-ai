import type { VaultEntry } from '@imajin/vault-core';
import { registerReactor, type BusEvent, type BusEventMap, type ReactorHandler } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { vaultService } from '@/src/lib/vault';

const log = createLogger('kernel');
const VAULT_HOT_RELOAD_REACTOR = 'vault-hot-reload';
const VAULT_EVENT_TYPES = new Set<BusEvent['type']>(['vault.secret.updated', 'vault.secret.rotated']);
let reactorRegistered = false;

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
async function notifySubscribers(field: string, entry: VaultEntry): Promise<void> {
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

function extractFieldFromEventPayload(event: BusEvent): string | null {
  if (!VAULT_EVENT_TYPES.has(event.type)) {
    return null;
  }

  const payload = event.payload;
  if (!payload || typeof payload.field !== 'string' || payload.field.length === 0) {
    return null;
  }

  return payload.field;
}

const vaultHotReloadReactor: ReactorHandler = async (event) => {
  const field = extractFieldFromEventPayload(event);
  if (!field) {
    return;
  }

  const latest = await vaultService.get(field);
  if (!latest) {
    log.warn({ field, type: event.type }, 'Vault hot-reload skipped because latest entry is missing');
    return;
  }

  await notifySubscribers(field, latest);
};

export function ensureVaultHotReloadReactorRegistered(): void {
  if (reactorRegistered) {
    return;
  }

  registerReactor(VAULT_HOT_RELOAD_REACTOR, vaultHotReloadReactor);
  reactorRegistered = true;
  log.info({ reactor: VAULT_HOT_RELOAD_REACTOR }, 'Vault hot-reload reactor registered');
}
