import { getClient } from '@imajin/db';
import { ConfigForm } from './config-form';

const sql = getClient();

function formatBps(bps: number | null): string {
  if (bps == null) return '—';
  return `${(bps / 100).toFixed(2)}%`;
}

export default async function AdminConfigPage() {
  const [relayConfig] = await sql`
    SELECT did, imajin_did, node_fee_bps, buyer_credit_bps
    FROM relay.relay_config
    WHERE id = 'singleton'
    LIMIT 1
  `;

  const [regModeRow] = await sql`
    SELECT value FROM registry.node_config WHERE key = 'registration_mode'
  `;
  const [maxIdsRow] = await sql`
    SELECT value FROM registry.node_config WHERE key = 'max_identities'
  `;
  const [maxStorageRow] = await sql`
    SELECT value FROM registry.node_config WHERE key = 'max_storage_per_did_mb'
  `;

  const [profileRow] = await sql`
    SELECT display_name FROM profile.profiles WHERE did = ${relayConfig?.imajin_did ?? ''} LIMIT 1
  `;

  const registrationMode = (regModeRow?.value as string | null) ?? 'invite_only';
  const maxIdentities = Number(maxIdsRow?.value ?? 0);
  const maxStoragePerDidMb = Number(maxStorageRow?.value ?? 0);

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-primary font-mono">Node Config</h1>
        <p className="mt-1 text-sm text-secondary dark:text-secondary">
          Node identity, registration settings, and resource limits
        </p>
      </div>

      {/* Node Identity (read-only) */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-6 mb-6">
        <h2 className="text-sm font-semibold text-secondary dark:text-secondary uppercase tracking-wide mb-4 font-mono">
          Node Identity
        </h2>
        <dl className="space-y-3">
          {profileRow?.display_name && (
            <div>
              <dt className="text-xs text-secondary dark:text-secondary mb-0.5">Node Name</dt>
              <dd className="text-sm text-gray-900 dark:text-primary font-medium">
                {profileRow.display_name as string}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-secondary dark:text-secondary mb-0.5">Imajin DID</dt>
            <dd className="font-mono text-xs text-gray-900 dark:text-primary break-all">
              {relayConfig?.imajin_did ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-secondary dark:text-secondary mb-0.5">DFOS DID</dt>
            <dd className="font-mono text-xs text-gray-900 dark:text-primary break-all">
              {relayConfig?.did ?? '—'}
            </dd>
          </div>
        </dl>
      </div>

      {/* Fee Configuration (read-only) */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-6 mb-6">
        <h2 className="text-sm font-semibold text-secondary dark:text-secondary uppercase tracking-wide mb-4 font-mono">
          Fee Configuration
        </h2>
        <dl className="grid grid-cols-2 gap-4">
          <div>
            <dt className="text-xs text-secondary dark:text-secondary mb-0.5">Node Fee</dt>
            <dd className="text-lg font-bold text-gray-900 dark:text-primary">
              {formatBps(relayConfig?.node_fee_bps as number | null)}
            </dd>
            <dd className="text-xs text-secondary dark:text-secondary">
              {relayConfig?.node_fee_bps ?? 0} bps
            </dd>
          </div>
          <div>
            <dt className="text-xs text-secondary dark:text-secondary mb-0.5">Buyer Credit</dt>
            <dd className="text-lg font-bold text-gray-900 dark:text-primary">
              {formatBps(relayConfig?.buyer_credit_bps as number | null)}
            </dd>
            <dd className="text-xs text-secondary dark:text-secondary">
              {relayConfig?.buyer_credit_bps ?? 0} bps
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-secondary dark:text-secondary">
          Fee settings are configured at the relay level and cannot be changed here.
        </p>
      </div>

      {/* Editable sections */}
      <ConfigForm
        registrationMode={registrationMode}
        maxIdentities={maxIdentities}
        maxStoragePerDidMb={maxStoragePerDidMb}
      />
    </div>
  );
}
