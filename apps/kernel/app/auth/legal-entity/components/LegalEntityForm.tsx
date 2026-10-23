'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  LEGAL_ENTITY_FIELDS, LEGAL_ENTITY_SCHEMA, LEGAL_ENTITY_VISIBILITIES,
  legalEntityFieldValue, validateLegalEntityInput,
  type LegalEntityField, type LegalEntityInput, type LegalEntityVisibilityMap,
} from '@/src/lib/profile/legal-entity-schema';

const LABELS: Record<LegalEntityField, string> = {
  legalName: 'Legal name', operatingName: 'Operating name (optional)',
  'address.line1': 'Address line 1', 'address.line2': 'Address line 2 (optional)',
  'address.city': 'City', 'address.region': 'Region', 'address.postalCode': 'Postal code',
  'address.country': 'Country (ISO 3166-1 alpha-2)',
};
function emptyRecord(): LegalEntityInput {
  return {
    schema: LEGAL_ENTITY_SCHEMA, legalName: '', operatingName: '',
    address: { line1: '', line2: '', city: '', region: '', postalCode: '', country: '' },
    visibility: Object.fromEntries(LEGAL_ENTITY_FIELDS.map(field => [field, 'on-consent'])) as LegalEntityVisibilityMap,
  };
}

const endpoint = '/auth/api/legal-entity';

export default function LegalEntityForm({ did }: Readonly<{ did: string }>) {
  const [record, setRecord] = useState(emptyRecord);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    let active = true;
    fetch(endpoint, { cache: 'no-store' }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Unable to load legal details');
      if (!active) return;
      if (data.document) {
        setRecord(data.document.record);
        setExists(true);
      }
    }).catch((error_: Error) => {
      if (active) { setError(error_.message); setLoadFailed(true); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [did]);

  function changeValue(field: LegalEntityField, value: string) {
    setRecord(current => {
      if (field === 'legalName' || field === 'operatingName') return { ...current, [field]: value };
      return { ...current, address: { ...current.address, [field.slice('address.'.length)]: value } };
    });
    setStatus('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setStatus('');
    let input: LegalEntityInput;
    try {
      input = validateLegalEntityInput(record);
    } catch (error_) {
      setError((error_ as Error).message);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Unable to save legal details');
      setRecord(input);
      setExists(true);
      setStatus('Signed legal-entity document saved.');
    } catch (error_) {
      setError((error_ as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!globalThis.confirm('Revoke this legal-entity document? It will no longer release any fields. Signed history is retained.')) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const response = await fetch(endpoint, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Unable to revoke legal details');
      setRecord(emptyRecord());
      setExists(false);
      setStatus('Legal-entity document revoked. Signed history is retained.');
    } catch (error_) {
      setError((error_ as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <output className="block text-sm text-zinc-400">Loading legal details…</output>;
  return (
    <section className="space-y-4 max-w-2xl">
      <h1 className="font-mono text-xl">Legal entity</h1>
      <p className="text-sm text-zinc-400">Legal details for <span className="font-mono break-all">{did}</span>. Available for people and businesses.</p>
      <p className="text-sm text-zinc-400">Saved as a signed legal-entity:v1 document in your media space at assets/legal-entity.md. Tax numbers stay in Tax registrations.</p>
      <p className="text-sm text-zinc-400">Public releases a field to anyone. On-consent requires a current raw-data consent grant. Never withholds it from all readers; you can still edit it here.</p>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {status && <output className="block text-sm text-green-400">{status}</output>}
      <form onSubmit={submit} noValidate className="space-y-3">
        <fieldset disabled={busy || loadFailed} className="space-y-3 disabled:opacity-60">
          <legend className="sr-only">Legal details and per-field visibility</legend>
          {LEGAL_ENTITY_FIELDS.map(field => (
            <div key={field} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <label className="text-sm font-mono space-y-1" htmlFor={field}>
                <span>{LABELS[field]}</span>
                <input id={field} value={legalEntityFieldValue(record, field) ?? ''} maxLength={200}
                  onChange={event => changeValue(field, event.target.value)}
                  className="block w-full bg-zinc-900 border border-zinc-700 px-3 py-2 text-zinc-100 focus:border-violet-500" />
              </label>
              <label className="text-sm font-mono space-y-1" htmlFor={`${field}-visibility`}>
                <span>Visibility</span>
                <select id={`${field}-visibility`} aria-label={`${LABELS[field]} visibility`} value={record.visibility[field]}
                  onChange={event => {
                    const visibility = event.target.value as LegalEntityVisibilityMap[LegalEntityField];
                    setRecord(current => ({ ...current, visibility: { ...current.visibility, [field]: visibility } }));
                    setStatus('');
                  }}
                  className="block w-full bg-zinc-900 border border-zinc-700 px-3 py-2 text-zinc-100 focus:border-violet-500">
                  {LEGAL_ENTITY_VISIBILITIES.map(visibility => <option key={visibility} value={visibility}>{visibility}</option>)}
                </select>
              </label>
            </div>
          ))}
          <div className="flex flex-wrap gap-3 pt-2">
            <button type="submit" className="bg-gradient-to-r from-violet-600 via-indigo-600 to-orange-600 px-4 py-2 font-mono text-zinc-100">{busy ? 'Saving…' : 'Save signed document'}</button>
            {exists && <button type="button" onClick={revoke} className="border border-red-700 px-4 py-2 font-mono text-red-400">Revoke document</button>}
          </div>
        </fieldset>
      </form>
    </section>
  );
}
