'use client';

/**
 * Server-backed list of provisioned apps inside the "Provision app" panel
 * (#2745). Unlike the panel's result block — which only follows the proposal
 * raised in the current page state — this list is read from the server, so an
 * approved provision, and its **Reissue claim code** control, survive a reload.
 * Reissue is offered only for apps whose claim code has not yet been redeemed
 * (Ryan's 2026-10-09 ruling on #2745, option a).
 */
import type { ProvisionedApp } from './provisioned-apps';

function ProvisionedAppRow({
  app,
  reissueBusy,
  onReissue,
}: Readonly<{ app: ProvisionedApp; reissueBusy: boolean; onReissue: (app: ProvisionedApp) => void }>) {
  return (
    <li className="flex items-center gap-2 text-xs" data-testid="provisioned-app" data-slug={app.slug}>
      <span className="font-mono text-gray-200">{app.slug}</span>
      <span className={app.claimed ? 'text-green-400' : 'text-amber-400'}>{app.claimed ? 'claimed' : 'unclaimed'}</span>
      {!app.claimed && (
        <button
          type="button"
          onClick={() => onReissue(app)}
          disabled={reissueBusy}
          data-testid="provisioned-app-reissue"
          className="ml-auto px-2.5 py-1 rounded text-xs font-medium bg-amber-800/60 text-amber-100 hover:bg-amber-700/60 disabled:opacity-40"
        >
          {reissueBusy ? 'Proposing…' : 'Reissue claim code'}
        </button>
      )}
    </li>
  );
}

export function ProvisionedAppsList({
  apps,
  reissueBusy,
  onReissue,
}: Readonly<{ apps: readonly ProvisionedApp[]; reissueBusy: boolean; onReissue: (app: ProvisionedApp) => void }>) {
  if (apps.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-gray-800 p-3 space-y-2" data-testid="provisioned-apps">
      <p className="text-xs font-medium text-gray-300">Provisioned apps</p>
      <ul className="space-y-1">
        {apps.map((app) => (
          <ProvisionedAppRow key={app.slug} app={app} reissueBusy={reissueBusy} onReissue={onReissue} />
        ))}
      </ul>
    </div>
  );
}
