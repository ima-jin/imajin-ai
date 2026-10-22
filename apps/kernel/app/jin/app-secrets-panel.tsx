'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AppDeclaredSecretStatus } from '@/src/lib/apps/self-secrets';
import type { AppSecretAction } from '@/src/lib/apps/secrets-kind';
import type { AppSecretsProvenance } from '@/src/lib/apps/secrets-metadata';
import { approvalCardAnchorId, requestApprovalsRefresh } from './approval-anchor';
import { provisionReissueAnchorId } from './provision-anchor';


interface AppSecretCard {
  appDid: string | null;
  name: string;
  slug: string | null;
  active: boolean;
  claimed: boolean;
  provisionFailed?: boolean;
  // Optional only for older metadata responses; new API responses include both.
  claimExpiresAt?: string | null;
  provenance?: AppSecretsProvenance;
  secrets: AppDeclaredSecretStatus[];
}

const UNKNOWN_PROVENANCE = 'unknown (pre-#3006 row)';
function claimLabel(app: AppSecretCard): string {
  if (app.claimed) return 'claimed';
  return app.provisionFailed ? 'provision failed' : 'awaiting claim';
}

function ProvenanceTime({ at }: Readonly<{ at?: string | null }>) {
  return at ? <time dateTime={at}>{at}</time> : UNKNOWN_PROVENANCE;
}

function AppProvenanceLines({ app }: Readonly<{ app: AppSecretCard }>) {
  const provenance = app.provenance;
  return (
    <dl className="space-y-1 text-xs text-gray-400 [overflow-wrap:anywhere]">
      <div><dt className="inline font-mono text-gray-300">Created</dt><dd className="inline">
        {' · '}<ProvenanceTime at={provenance?.created.at} />{' · registrar '}
        <span className="font-mono">{provenance?.created.by ?? UNKNOWN_PROVENANCE}</span>
      </dd></div>
      <div><dt className="inline font-mono text-gray-300">Provisioned</dt><dd className="inline">
        {' · '}<ProvenanceTime at={provenance?.provisioned.at} />{' · proposed by '}
        <span className="font-mono">{provenance?.provisioned.proposedBy ?? UNKNOWN_PROVENANCE}</span>
        {' · approved by '}<span className="font-mono">{provenance?.provisioned.approvedBy ?? UNKNOWN_PROVENANCE}</span>
      </dd></div>
      <div><dt className="inline font-mono text-gray-300">Claimed</dt><dd className="inline">
        {!app.claimed && !provenance?.claimed.at ? ' · not claimed yet' : <>{' · '}<ProvenanceTime at={provenance?.claimed.at} /></>}
        {' · host '}<span className="font-mono">{provenance?.claimed.by ?? UNKNOWN_PROVENANCE}</span>
      </dd></div>
      <div><dt className="inline font-mono text-gray-300">Last seen</dt><dd className="inline">
        {' · '}<ProvenanceTime at={provenance?.lastSeen.at} />{' · by '}
        <span className="font-mono">{provenance?.lastSeen.by ?? UNKNOWN_PROVENANCE}</span>
      </dd></div>
    </dl>
  );
}

function AwaitingClaim({ app }: Readonly<{ app: AppSecretCard }>) {
  const expired = app.claimExpiresAt && Date.parse(app.claimExpiresAt) <= Date.now();
  return (
    <div className="space-y-1 text-xs text-gray-400">
      <p>Claim code {expired ? 'expired' : 'expires'}{' · '}<ProvenanceTime at={app.claimExpiresAt} /></p>
      {app.slug && <a href={`#${provisionReissueAnchorId(app.slug)}`} className="inline-block py-2 text-amber-300 underline">
        Reissue claim code
      </a>}
      <p>Claim the app before proposing secret changes.</p>
    </div>
  );
}

function OperatorSecretEntry({ name, active, busy, submit }: Readonly<{
  name: string;
  active: boolean;
  busy: boolean;
  submit: (value: string) => Promise<void>;
}>) {
  return (
    <form className="flex gap-3" onSubmit={(event) => {
      event.preventDefault();
      const input = event.currentTarget.elements.namedItem('secret-value') as HTMLInputElement;
      const value = input.value;
      input.value = '';
      if (value) void submit(value);
    }}>
      <input type="password" name="secret-value" aria-label={`New value for ${name}`}
        autoComplete="off" autoCapitalize="none" spellCheck={false} required disabled={busy}
        className="min-w-0 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
        placeholder="Enter value — never revealed" />
      <button type="submit" disabled={busy} className="text-xs text-amber-300 disabled:opacity-40">
        {active ? 'Rotate' : 'Set'}
      </button>
    </form>
  );
}

function SecretStatus({ secret }: Readonly<{ secret: AppDeclaredSecretStatus }>) {
  if (secret.kind !== 'operator-supplied') return secret.status;
  const rotated = secret.timeline.findLast((entry) => entry.phase === 'rotated');
  return <>{secret.status === 'active' ? 'set' : 'not set'}{rotated && (
    <> · last rotated <time dateTime={rotated.at}>{rotated.at}</time></>
  )}</>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isTimelineEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.phase === 'string' && ['minted', 'granted', 'fetched', 'rotated', 'revoked'].includes(value.phase)
    && typeof value.at === 'string'
    && ['operatorDid', 'via', 'grantId'].every((key) => value[key] === undefined || typeof value[key] === 'string');
}
function isSecretMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string' && ['random-32B', 'random-64B', 'operator-supplied'].includes(value.kind as string)
    && typeof value.status === 'string' && ['missing', 'active', 'revoked'].includes(value.status)
    && Array.isArray(value.timeline) && value.timeline.every(isTimelineEntry);
}
function isAppSecretCard(value: unknown): value is AppSecretCard {
  if (!isRecord(value)) return false;
  return (value.appDid === null || typeof value.appDid === 'string')
    && (value.slug === null || typeof value.slug === 'string') && typeof value.name === 'string'
    && typeof value.active === 'boolean' && typeof value.claimed === 'boolean'
    && (value.provisionFailed === undefined || typeof value.provisionFailed === 'boolean')
    && (value.claimExpiresAt === undefined || isNullableTimestamp(value.claimExpiresAt))
    && (value.provenance === undefined || isAppProvenance(value.provenance))
    && Array.isArray(value.secrets) && value.secrets.every(isSecretMetadata);
}
function isNullableString(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}
function isNullableTimestamp(value: unknown): boolean {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}
function isAppProvenance(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const provisioned = value.provisioned;
  return ['created', 'claimed', 'lastSeen'].every((key) => {
    const line = value[key];
    return isRecord(line) && isNullableTimestamp(line.at) && isNullableString(line.by);
  }) && isRecord(provisioned)
    && isNullableTimestamp(provisioned.at)
    && ['proposedBy', 'approvedBy'].every((key) => isNullableString(provisioned[key]));
}

/** No reveal. Submitted values leave the field immediately and never enter React state. */
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
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.apps) || !body.apps.every(isAppSecretCard)) {
        setApps(null);
        setNotice('App-secret metadata unavailable.');
        return;
      }
      setApps(body.apps);
    } catch { setNotice('App-secret metadata unavailable.'); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const propose = async (appDid: string, action: AppSecretAction, name?: string, value?: string) => {
    setBusy(true);
    setProposalId('');
    try {
      const response = await fetch('/jin/api/app-secrets', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appDid, action, ...(name ? { name } : {}), ...(value === undefined ? {} : { value }) }),
      });
      const body = await response.json() as { proposalId?: string; error?: string };
      if (!response.ok || !body.proposalId) {
        setNotice(value === undefined ? body.error ?? 'App-secret proposal failed.' : 'App-secret proposal failed.');
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
    <section className="mt-8 min-w-0 space-y-3 [overflow-wrap:anywhere]" data-testid="app-secrets-panel">
      <h2 className="text-base font-semibold text-gray-100">App secrets</h2>
      <p className="text-xs text-gray-500">
        Names and status only — no reveal. Sync reads the app manifest; all changes require your signature.
        Enter operator-supplied values here once; they are sealed pending your countersignature.
        Rotation takes effect on the app&apos;s next boot. Rotating SESSION_SECRET signs users out when the app restarts.
      </p>
      {notice && <output className="block text-xs text-amber-300">{notice}{proposalId && (
        <> <a className="underline" href={`#${approvalCardAnchorId(proposalId)}`}>Review proposal</a></>
      )}</output>}
      {apps.length === 0 && <p className="text-xs text-gray-500">No apps on the self-secret rail yet.</p>}
      {apps.map((app) => (
        <article key={app.appDid ?? app.slug} className="min-w-0 border border-gray-800 p-3 space-y-2">
          <h3 className="font-mono text-sm font-medium">{app.name} <span className={`text-xs ${app.claimed ? 'text-green-400' : 'text-amber-400'}`}>{claimLabel(app)}</span></h3>
          <p className="text-xs font-mono text-gray-500">{app.appDid ?? 'Awaiting registry identity'}</p>
          <AppProvenanceLines app={app} />
          {app.active && app.claimed && app.appDid && app.slug && (
            <button type="button" disabled={busy} className="text-xs text-amber-300 disabled:opacity-40"
              onClick={() => void propose(app.appDid!, 'sync')}>Sync manifest secrets</button>
          )}
          {!app.claimed && !app.provisionFailed && <AwaitingClaim app={app} />}
          {app.secrets.length === 0 && <p className="text-xs text-gray-500">No registered self-secret declarations.</p>}
          {app.secrets.map((secret) => (
            <div key={secret.name} className="border-t border-gray-800 pt-2 space-y-1">
              <p className="text-xs"><span className="font-mono">{secret.name}</span> · {secret.kind} · <SecretStatus secret={secret} /></p>
              {secret.kind !== 'operator-supplied' && <ol className="text-xs text-gray-500 space-y-1">
                {secret.timeline.map((entry, index) => (
                  <li key={`${entry.phase}:${entry.at}:${index}`}>
                    {entry.phase} · <time dateTime={entry.at}>{entry.at}</time>
                    {entry.operatorDid && <> · signed by <span className="font-mono">{entry.operatorDid}</span></>}
                    {entry.via && <> · via <span className="font-mono">{entry.via}</span></>}
                  </li>
                ))}
              </ol>}
              {app.active && app.claimed && app.appDid && secret.kind === 'operator-supplied' && (
                <OperatorSecretEntry name={secret.name} active={secret.status === 'active'} busy={busy}
                  submit={(value) => propose(app.appDid!, secret.status === 'active' ? 'rotate' : 'set', secret.name, value)} />
              )}
              {app.active && app.claimed && app.appDid && secret.status === 'active' && (
                <div className="flex gap-3">
                  {secret.kind !== 'operator-supplied' && <button type="button" disabled={busy} className="text-xs text-amber-300 disabled:opacity-40"
                    onClick={() => void propose(app.appDid!, 'rotate', secret.name)}>Rotate</button>}
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
