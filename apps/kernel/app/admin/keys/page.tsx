import { requireAdmin } from '@imajin/auth';
import { redirect } from 'next/navigation';
import { KeysPanel } from './keys-panel';

export const dynamic = 'force-dynamic';

export default async function AdminKeysPage() {
  if (!(await requireAdmin())) redirect('/');

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Node keys</h1>
      <p className="mt-2 mb-6 text-sm text-gray-500 dark:text-gray-400">
        Rotate the node signing identity using public material only. Never paste or upload private keys.
        Generate keys, sign the public payload, and change configuration offline using the rotation runbook.
      </p>
      <KeysPanel />
    </div>
  );
}
