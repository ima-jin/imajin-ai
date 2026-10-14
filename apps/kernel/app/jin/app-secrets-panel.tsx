'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AppDeclaredSecretStatus } from '@/src/lib/apps/self-secrets';
import type { AppSecretAction } from '@/src/lib/apps/secrets-kind';
import { approvalCardAnchorId, requestApprovalsRefresh } from './approval-anchor';

interface AppSecretCard {
  appDid: string | null;
  name: string;
  slug: string | null;
  active: boolean;
  claimed: boolean;
  secrets: AppDeclaredSecretStatus[];
}

/** Metadata only. The sole write affordance stages a countersign proposal. */
export function AppSecretsPanel() {
  const [apps, setApps] = useState<AppSecretCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [proposalId, setProposalId] = useState('');
  const load = useCallback(async () => {
    try {
      const response = await fetch('/jin/api/app-secrets', { credentials: 'include' });
      if (response.status === 401 || response.status === 403) { setApps(null); return; }
      if (!response.ok) { setNotice('App-secret metadata unavailable.'); return; }
      const body = await response.json() as { apps: AppSecretCard[] };
      setApps(body.apps);
    } catch { setNotice('App-secret metadata unavailable.'); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const propose = async (appDid: string, action: AppSecretAction, name?: string) => {
    setBusy(true);
    setProposalId('');
    try {
      const response = await fetch('/jin/api/app-secrets', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appDid, action, ...(name ? { name } : {}) }),
      });
      const body = await response.json() as { proposalId?: string; error?: string };
      if (!response.ok || !body.proposalId) {
        setNotice(body.error ?? 'App-secret proposal failed.');
        return;
      }
      setNotice('Proposal pending — nothing changes until you countersign in Operator approvals.');
      setProposalId(body.proposalId);
      requestApprovalsRefresh();
    } catch { setNotice('App-secret proposal failed.'); }
    finally { setBusy(false); }
  };
  if (apps === null) return null;
  return (
    <section className="mt-8 space-y-3" data-testid="app-secrets-panel">
      <h2 className="text-base font-semibold text-gray-100">App secrets</h2>
      <p className="text-xs text-gray-500">
        Names, recipes and signed lifecycle only — no reveal. Sync reads the app manifest; all changes require your signature.
        Rotation takes effect on the app&apos;s next boot. Rotating SESSION_SECRET signs users out when the app restarts.
      </p>
      {notice && <p className="text-xs text-amber-300" role="status">{notice}{proposalId && (
        <> <a className="underline" href={`#${approvalCardAnchorId(proposalId)}`}>Review proposal</a></>
      )}</p>}
      {apps.length === 0 && <p className="text-xs text-gray-500">No registered or provisioned apps yet.</p>}
      {apps.map((app) => (
        <article key={app.appDid ?? app.slug} className="rounded-lg border border-gray-800 p-3 space-y-2">
          <h3 className="text-sm font-medium">{app.name} <span className="text-xs text-gray-500">{app.claimed ? 'claimed' : 'unclaimed'}</span></h3>
          <p className="text-xs font-mono text-gray-500">{app.appDid ?? 'Awaiting registry identity'}</p>
          {app.active && app.claimed && app.appDid && app.slug && (
            <button type="button" disabled={busy} className="text-xs text-amber-300 disabled:opacity-40"
              onClick={() => void propose(app.appDid!, 'sync')}>Sync manifest secrets</button>
          )}
          {!app.claimed && <p className="text-xs text-gray-500">Claim the app before proposing secret changes.</p>}
          {app.secrets.length === 0 && <p className="text-xs text-gray-500">No registered self-secret declarations.</p>}
          {app.secrets.map((secret) => (
            <div key={secret.name} className="border-t border-gray-800 pt-2 space-y-1">
              <p className="text-xs"><span className="font-mono">{secret.name}</span> · {secret.kind} · {secret.status}</p>
              <ol className="text-xs text-gray-500 space-y-1">
                {secret.timeline.map((entry, index) => (
                  <li key={`${entry.phase}:${entry.at}:${index}`}>
                    {entry.phase} · <time dateTime={entry.at}>{entry.at}</time>
                    {entry.operatorDid && <> · signed by <span className="font-mono">{entry.operatorDid}</span></>}
                    {entry.via && <> · via <span className="font-mono">{entry.via}</span></>}
                  </li>
                ))}
              </ol>
              {app.active && app.claimed && app.appDid && secret.status === 'active' && (
                <div className="flex gap-3">
                  <button type="button" disabled={busy} className="text-xs text-amber-300 disabled:opacity-40"
                    onClick={() => void propose(app.appDid!, 'rotate', secret.name)}>Rotate</button>
                  <button type="button" disabled={busy} className="text-xs text-red-300 disabled:opacity-40"
                    onClick={() => void propose(app.appDid!, 'revoke', secret.name)}>Revoke</button>
                </div>
              )}
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
