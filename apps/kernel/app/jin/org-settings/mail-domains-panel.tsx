'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MailDomainStatus } from '@/src/lib/mail/postal-contract';
import type { MailDomainGuidance } from '@/src/lib/mail/domain-guidance';

type DomainView = MailDomainStatus & { error: string | null; guidance: MailDomainGuidance };
type Settings = { domains: DomainView[]; availableDomains: string[] };

async function readSettings(url: string, signal: AbortSignal): Promise<Settings> {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
  if (!response.ok) throw new Error('Unable to load mail domains. Check your organization access and retry.');
  return response.json();
}

export function MailDomainsPanel({ ownerDid }: Readonly<{ ownerDid: string }>) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const url = `/jin/api/orgs/${encodeURIComponent(ownerDid)}/mail-domains`;
  const refresh = useCallback(() => setVersion(value => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    readSettings(url, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setSettings(value);
      setSelected(current => value.availableDomains.includes(current) ? current : value.availableDomains[0] ?? '');
    }).catch(() => {
      if (!controller.signal.aborted) setError('Unable to load mail domains. Check your organization access and retry.');
    });
    return () => controller.abort();
  }, [url, version]);

  useEffect(() => {
    if (!settings?.domains.some(domain => domain.state === 'pending')) return;
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [settings, refresh]);

  async function mutate(domain: string, check: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(check ? `${url}/${encodeURIComponent(domain)}/check` : url, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        ...(check ? {} : { body: JSON.stringify({ domain }) }),
      });
      if (!response.ok) {
        throw new Error('Mail setup could not complete. Verify ownership and ask the node operator to check Postal configuration.');
      }
    } catch {
      setError('Mail setup could not complete. Verify ownership and ask the node operator to check Postal configuration.');
    } finally {
      setBusy(false);
      refresh();
    }
  }

  return (
    <section aria-label="Mail domains" className="space-y-4 rounded-xl border border-gray-800 p-4">
      <h2 className="text-lg font-semibold">Mail domain verification</h2>
      <p className="text-sm text-gray-400">Send-only setup leaves your mailbox provider and MX records unchanged. Verify domain ownership first.</p>
      {error && <p role="alert" className="text-red-400">{error}</p>}
      <button type="button" onClick={refresh} disabled={busy} className="rounded border border-gray-600 px-4 py-2">Refresh mail status</button>
      {!settings && !error && <p>Loading mail domains…</p>}
      {settings?.availableDomains.length === 0 && <p>No verified owner domains. Verify a domain in identity settings first.</p>}
      {!!settings?.availableDomains.length && (
        <div className="space-y-2">
          <label className="block"><span>Verified owner domain</span>
            <select className="mt-1 block w-full rounded bg-gray-900 p-3" value={selected} onChange={event => setSelected(event.target.value)}>
              {settings.availableDomains.map(domain => <option key={domain} value={domain}>{domain}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy || !selected} onClick={() => void mutate(selected, false)} className="rounded bg-amber-600 px-4 py-3 disabled:opacity-50">Set up domain mail</button>
        </div>
      )}
      {settings?.domains.map(domain => (
        <article key={domain.domain} aria-label={`Mail status for ${domain.domain}`} className="space-y-3 border-t border-gray-800 pt-3">
          <h3 className="break-words font-medium">{domain.domain} — {domain.state}</h3>
          <p>Ownership: {domain.ownershipVerified ? 'verified' : 'pending'}; sending DNS: {domain.dnsOk ? 'verified' : 'pending'}</p>
          {domain.checkedAt && <p>Last DNS check: {domain.checkedAt}</p>}
          {domain.state === 'disabled' && <p>Sending disabled. Verify current ownership and provision again before using this domain.</p>}
          {domain.error && <p role="alert">Mail provisioning needs attention ({domain.error}). Sending remains gated on verification.</p>}
          {domain.guidance.error && <p role="alert">Current SPF could not be safely read. No SPF record is suggested; retry after checking DNS. Never add a second SPF policy.</p>}
          {domain.state !== 'disabled' && (
            <>
              <p className="text-sm text-gray-400">Records to add or update. SPF below is merged with your current policy: update that record, never add a second SPF TXT.</p>
              <dl className="space-y-3">
                {domain.guidance.records.filter(record => record.kind !== 'mx').map(record => (
                  <div key={`${record.kind}:${record.name}`} className="break-all rounded bg-gray-900 p-3">
                    <dt>{record.kind} · {record.type} · {record.name} {record.required ? '(required)' : '(optional)'}</dt>
                    <dd><code>{record.value}</code></dd>
                    <dd>Status: {record.status}{record.error && ` — ${record.error}`}</dd>
                  </div>
                ))}
              </dl>
              <button type="button" disabled={busy} onClick={() => void mutate(domain.domain, true)} className="rounded border border-amber-700 px-4 py-3 disabled:opacity-50">Check {domain.domain}</button>
            </>
          )}
        </article>
      ))}
    </section>
  );
}
