import { VaultPanel } from './vault-panel';
import type { VaultHistoryEntry, VaultSecretRow } from './types';

const initialSecrets: VaultSecretRow[] = [
  {
    field: 'GH_TOKEN',
    hint: 'ghp_...',
    cid: 'bafyrei0ghv12token0seed',
    setBy: '@ryan',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    status: 'confirmed',
  },
  {
    field: 'OPENAI_API_KEY',
    hint: 'sk-p...',
    cid: 'bafyrei0opn12apikeyseed',
    setBy: '@debbie',
    updatedAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
    status: 'pending',
  },
];

const initialHistory: Record<string, VaultHistoryEntry[]> = {
  GH_TOKEN: [
    {
      field: 'GH_TOKEN',
      cid: 'bafyrei0ghv12token0seed',
      setBy: '@ryan',
      updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
      action: 'set',
    },
  ],
  OPENAI_API_KEY: [
    {
      field: 'OPENAI_API_KEY',
      cid: 'bafyrei0opn12apikeyseed',
      setBy: '@debbie',
      updatedAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
      action: 'rotate',
    },
    {
      field: 'OPENAI_API_KEY',
      cid: 'bafyrei0opn12apikeyold0',
      setBy: '@debbie',
      updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 28).toISOString(),
      action: 'set',
    },
  ],
};

export default function AdminVaultPage() {
  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Vault</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Manage encrypted secrets with set, rotate, and history workflows.
        </p>
      </div>
      <VaultPanel initialSecrets={initialSecrets} initialHistory={initialHistory} />
    </div>
  );
}
