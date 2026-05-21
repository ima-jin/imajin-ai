import { VaultPanel } from './vault-panel';

export default function AdminVaultPage() {
  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Vault</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Manage encrypted secrets with live set, rotate, and history workflows.
        </p>
      </div>
      <VaultPanel />
    </div>
  );
}
