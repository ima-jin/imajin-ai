import path from 'node:path';
import os from 'node:os';
import {
  FileVaultRepository,
  VaultEntryService,
  InMemoryFieldLock,
  createDefaultAdapters,
} from '@imajin/vault-core';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const vaultPath = process.env.VAULT_PATH ?? path.join(os.homedir(), '.imajin', 'vault.json');

const repository = new FileVaultRepository({ vaultPath });
const lock = new InMemoryFieldLock();
const adapters = createDefaultAdapters();

export const vaultService = new VaultEntryService(repository, {
  lock,
  adapters,
});

log.info({ vaultPath }, 'Vault service initialised');
