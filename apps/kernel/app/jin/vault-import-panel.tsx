'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { approvalCardAnchorId, requestApprovalsRefresh } from './approval-anchor';
import { CLOUDFLARE_CAPABILITIES, cloudflarePurpose, isCloudflareImport, type CloudflareImport } from '@/src/lib/cloudflare/contract';
import { CloudflareDelegations } from './cloudflare-delegations';
import { cloudflareFormText } from './cloudflare-client';

interface VaultOwner {
  did: string;
  name: string;
}

interface ImportCard {
  field: string;
  ownerDid: string;
  consumerDid: string;
  purpose: string;
  label?: string | null;
  fingerprint: string;
  grantId: string | null;
  provenance: 'imported';
  status: string;
  timeline: { type: string; at: string; alert?: boolean }[];
  cloudflare?: CloudflareImport;
}

interface ImportMetadata {
  ownerDid: string;
  owners: VaultOwner[];
  cards: ImportCard[];
  domains?: { domain: string; ownerDid: string }[];
  nodeDid?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImportCard(value: unknown): value is ImportCard {
  if (!isRecord(value)) return false;
  return ['field', 'ownerDid', 'consumerDid', 'purpose', 'fingerprint', 'status']
    .every((key) => typeof value[key] === 'string')
    && value.provenance === 'imported'
    && (value.cloudflare === undefined || isCloudflareImport(value.cloudflare))
    && (value.label === undefined || value.label === null || typeof value.label === 'string')
    && (value.grantId === null || typeof value.grantId === 'string')
    && Array.isArray(value.timeline)
    && value.timeline.every((event) => isRecord(event) && typeof event.type === 'string' && typeof event.at === 'string');
}

function isImportMetadata(value: unknown): value is ImportMetadata {
  if (!isRecord(value) || typeof value.ownerDid !== 'string') return false;
  return Array.isArray(value.owners) && value.owners.length > 0
    && (value.nodeDid === undefined || typeof value.nodeDid === 'string')
    && (value.domains === undefined || (Array.isArray(value.domains) && value.domains.every(domain =>
      isRecord(domain) && typeof domain.domain === 'string' && typeof domain.ownerDid === 'string')))
    && value.owners.every((owner) => isRecord(owner) && typeof owner.did === 'string' && typeof owner.name === 'string')
    && value.owners.some((owner) => owner.did === value.ownerDid)
    && Array.isArray(value.cards) && value.cards.every(isImportCard);
}

const inputClass = 'w-full min-w-0 rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100';

function ImportedCredentialCard({ card, onRotate, busy }: Readonly<{
  card: ImportCard;
  onRotate: (card: ImportCard) => void;
  busy: boolean;
}>) {
  return (
    <article className="min-w-0 rounded-lg border border-gray-800 p-3 space-y-2" data-testid="imported-credential-card">
      <h3 className="text-sm font-medium break-words">{card.label || card.purpose} · {card.status}</h3>
      <p className="text-xs break-all text-gray-400">Owner: {card.ownerDid}</p>
      <p className="text-xs break-all text-gray-400">Consumer: {card.consumerDid}</p>
      <p className="text-xs break-words text-gray-400">Purpose: {card.purpose}</p>
      <p className="text-xs font-mono break-all text-gray-500">Fingerprint: {card.fingerprint}</p>
      <p className="text-xs text-gray-500">provenance: imported · hand-provisioned</p>
      <ol className="space-y-1 text-xs">
        {card.timeline.map((event, index) => (
          <li key={`${event.type}:${event.at}:${index}`} data-timeline-type={event.type}
            className={event.alert ? 'border-l-2 border-red-700 pl-2 text-red-300' : 'border-l-2 border-gray-700 pl-2 text-gray-400'}>
            {event.type} · <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
            {event.alert && ' · no ack yet'}
          </li>
        ))}
      </ol>
      {['active', 'expired'].includes(card.status) && (
        <button type="button" disabled={busy} onClick={() => onRotate(card)}
          className="min-h-11 text-sm text-amber-300 disabled:opacity-40">Re-import to rotate</button>
      )}
      {card.cloudflare && <CloudflareDelegations ownerDid={card.ownerDid} zone={card.cloudflare} />}
    </article>
  );
}

/** Plaintext stays in an uncontrolled masked field, never React state or the approval record. */
export function VaultImportPanel() {
  const [cloudflare, setCloudflare] = useState(false);
  const [metadata, setMetadata] = useState<ImportMetadata | null>(null);
  const [ownerDid, setOwnerDid] = useState('');
  const [replacement, setReplacement] = useState<ImportCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [proposalId, setProposalId] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/vault/import', { credentials: 'include', cache: 'no-store' });
      if (!response.ok) { setMetadata(null); return; }
      const body: unknown = await response.json();
      if (!isImportMetadata(body)) { setMetadata(null); return; }
      setMetadata(body);
      setOwnerDid((current) => body.owners.some((owner) => owner.did === current) ? current : body.ownerDid);
    } catch { setMetadata(null); }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const input = formRef.current?.elements.namedItem('secret') as HTMLInputElement | null;
    if (input) input.value = '';
  }, [ownerDid]);

  const rotate = (card: ImportCard) => {
    setCloudflare(!!card.cloudflare);
    setOwnerDid(card.ownerDid);
    setReplacement(card);
    setProposalId('');
    setNotice('Paste the replacement below. The old grant stays active until you approve the replacement.');
    const form = formRef.current;
    if (!form) return;
    (form.elements.namedItem('purpose') as HTMLInputElement).value = card.purpose;
    (form.elements.namedItem('consumerDid') as HTMLInputElement).value = card.consumerDid;
    (form.elements.namedItem('label') as HTMLInputElement).value = card.label ?? '';
    if (card.cloudflare) {
      (form.elements.namedItem('domain') as HTMLSelectElement).value = card.cloudflare.domain;
      (form.elements.namedItem('zoneId') as HTMLInputElement).value = card.cloudflare.zoneId;
      (form.elements.namedItem('granteeDid') as HTMLInputElement).value = card.cloudflare.granteeDid;
      form.querySelectorAll<HTMLInputElement>('input[name="capabilities"]').forEach(input => {
        input.checked = card.cloudflare!.capabilities.includes(input.value as typeof CLOUDFLARE_CAPABILITIES[number]);
      });
    }
    const input = form.elements.namedItem('secret') as HTMLInputElement;
    input.value = '';
    input.focus();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem('secret') as HTMLInputElement;
    const secret = input.value;
    input.value = '';
    setProposalId('');
    setBusy(true);
    try {
      const values = new FormData(form);
      const rawExpiry = values.get('expiresAt');
      const expiry = typeof rawExpiry === 'string' ? rawExpiry : '';
      const response = await fetch('/api/vault/import', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerDid, secret,
          ...(cloudflare ? {
            purpose: cloudflarePurpose(cloudflareFormText(values, 'zoneId')), consumerDid: metadata?.nodeDid,
            cloudflare: {
              domain: values.get('domain'), zoneId: values.get('zoneId'),
              granteeDid: values.get('granteeDid'), capabilities: values.getAll('capabilities'),
            },
          } : { purpose: values.get('purpose'), consumerDid: values.get('consumerDid') }),
          ...(values.get('label') ? { label: values.get('label') } : {}),
          ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}),
          ...(replacement ? { replacesField: replacement.field } : {}),
        }),
      });
      // Never render a provider/server error: it could contain the submitted value.
      if (!response.ok) { setNotice('Import proposal failed. The value was cleared; paste again to retry.'); return; }
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.proposalId !== 'string') {
        setNotice('Import proposal failed. The value was cleared; paste again to retry.');
        return;
      }
      setProposalId(body.proposalId);
      setNotice('Sealed pending approval. Review and countersign as yourself in Operator approvals. The selected identity owns the secret.');
      setReplacement(null);
      requestApprovalsRefresh();
      void load();
    } catch { setNotice('Import proposal failed. The value was cleared; paste again to retry.'); }
    finally { setBusy(false); }
  };

  if (!metadata) return null;
  const owner = metadata.owners.find((entry) => entry.did === ownerDid);
  const submitLabel = replacement ? 'Seal replacement and propose rotation' : 'Seal and propose import';
  return (
    <section className="mt-8 min-w-0 space-y-3" data-testid="vault-import-panel">
      <h2 className="text-base font-semibold text-gray-100">Import credential</h2>
      <p className="text-xs text-gray-400">
        Paste a third-party credential once. It is sealed in this identity&apos;s vault, never revealed or copied.
        Approval issues a purpose-bound grant to the agent or service DID below.
      </p>
      {notice && <output className="block text-xs text-amber-300">{notice}{proposalId && (
        <> <a className="underline" href={`#${approvalCardAnchorId(proposalId)}`}>Review import proposal</a></>
      )}</output>}
      <form ref={formRef} onSubmit={(event) => void submit(event)}
        className="min-w-0 rounded-lg border border-gray-800 p-3 space-y-3">
        <label className="block text-xs text-gray-300"><span>Import mode</span>
          <select aria-label="Import mode" value={cloudflare ? 'cloudflare' : 'generic'} disabled={busy || replacement !== null}
            className={`${inputClass} mt-1`} onChange={event => {
              setCloudflare(event.target.value === 'cloudflare');
              const input = formRef.current?.elements.namedItem('secret') as HTMLInputElement | null;
              if (input) input.value = '';
            }}>
            <option value="generic">Generic credential</option>
            <option value="cloudflare">Cloudflare zone authority</option>
          </select>
        </label>
        <label className="block text-xs text-gray-300"><span>Owning identity</span>
          <select aria-label="Owning identity" value={ownerDid} disabled={busy || replacement !== null}
            onChange={(event) => {
              setOwnerDid(event.target.value);
              const input = formRef.current?.elements.namedItem('secret') as HTMLInputElement | null;
              if (input) input.value = '';
            }} className={`${inputClass} mt-1`}>
            {metadata.owners.map((entry) => <option key={entry.did} value={entry.did}>{entry.name} — {entry.did}</option>)}
          </select>
        </label>
        <fieldset hidden={!cloudflare} disabled={busy || !cloudflare} className="space-y-3">
          <legend className="text-xs text-gray-300">Cloudflare zone authority</legend>
          <p className="text-xs text-amber-200">Only the kernel node receives the sealed token. The grantee gets revocable zone operations, never credential access.</p>
          <label className="block text-xs text-gray-300"><span>Verified zone domain</span>
            <select name="domain" aria-label="Verified zone domain" required={cloudflare} className={`${inputClass} mt-1`}>
              <option value="">Select a verified zone</option>
              {(metadata.domains ?? []).filter(domain => domain.ownerDid === ownerDid).map(domain =>
                <option key={domain.domain} value={domain.domain}>{domain.domain}</option>)}
            </select>
          </label>
          <label className="block text-xs text-gray-300"><span>Cloudflare zone ID</span>
            <input name="zoneId" aria-label="Cloudflare zone ID" required={cloudflare} pattern="[a-f0-9]{32}" maxLength={32}
              autoCapitalize="none" spellCheck={false} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-xs text-gray-300"><span>Capability grantee DID</span>
            <input name="granteeDid" aria-label="Capability grantee DID" required={cloudflare}
              placeholder="did:imajin:…" autoCapitalize="none" spellCheck={false} className={`${inputClass} mt-1`} />
          </label>
          <div className="flex flex-wrap gap-3">
            {CLOUDFLARE_CAPABILITIES.map(capability => <label key={capability} className="text-xs text-gray-300 min-h-11 flex items-center gap-2">
              <input type="checkbox" name="capabilities" value={capability} defaultChecked={capability === 'cloudflare:read'} />
              {capability}
            </label>)}
          </div>
        </fieldset>
        <p className="rounded border border-amber-800/60 bg-amber-950/20 p-2 text-xs text-amber-200 break-all"
          data-testid="import-owner">Secret owner before sealing: {owner?.name} · {ownerDid}</p>
        {replacement && <div className="text-xs text-amber-300 break-all">
          Replacing {replacement.fingerprint}. Old access is revoked only after the replacement is granted.
          <button type="button" disabled={busy} onClick={() => {
            setReplacement(null);
            setNotice('');
            const input = formRef.current?.elements.namedItem('secret') as HTMLInputElement | null;
            if (input) input.value = '';
          }} className="ml-2 underline min-h-11">Cancel rotation</button>
        </div>}
        <div hidden={cloudflare}>
        <label className="block text-xs text-gray-300"><span>Purpose</span>
          <input name="purpose" aria-label="Purpose" required={!cloudflare} maxLength={200} disabled={busy || cloudflare}
            placeholder="e.g. SonarCloud analysis" className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-xs text-gray-300"><span>Consumer agent or service DID</span>
          <input name="consumerDid" aria-label="Consumer agent or service DID" required={!cloudflare} disabled={busy || cloudflare}
            placeholder="did:imajin:…" autoCapitalize="none" spellCheck={false} className={`${inputClass} mt-1`} />
        </label>
        </div>
        <label className="block text-xs text-gray-300"><span>Label (optional)</span>
          <input name="label" aria-label="Label (optional)" maxLength={200} disabled={busy} className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-xs text-gray-300"><span>Grant expiry (optional)</span>
          <input type="datetime-local" name="expiresAt" aria-label="Grant expiry (optional)" disabled={busy}
            className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-xs text-gray-300"><span>Credential</span>
          <input type="password" name="secret" aria-label="Credential" required disabled={busy} autoComplete="off"
            autoCapitalize="none" spellCheck={false} placeholder="Paste once — no reveal"
            className={`${inputClass} mt-1`} />
        </label>
        <button type="submit" disabled={busy} className="min-h-11 rounded bg-amber-700 px-3 py-2 text-sm text-white disabled:opacity-40">
          {busy ? 'Sealing…' : submitLabel}
        </button>
      </form>
      <p className="text-xs text-gray-500">{cloudflare
        ? 'Cloudflare tokens stay inside the kernel. Never use loadFromVault or an agent environment for this token. Manage zone grants below; the default action lease is 24 hours (maximum 30 days).'
        : 'Consumer boot: use loadFromVault with this purpose and acknowledge use. Remove the old .env.local credential line after migration; never paste it into a shell.'}</p>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        {metadata.cards.filter((card) => card.ownerDid === ownerDid).map((card) => (
          <ImportedCredentialCard key={card.field} card={card} onRotate={rotate} busy={busy} />
        ))}
      </div>
    </section>
  );
}
