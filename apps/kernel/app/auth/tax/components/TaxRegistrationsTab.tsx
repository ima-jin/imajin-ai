'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@imajin/ui';
import {
  TAX_REGISTRATION_KINDS,
  validateTaxRegistration,
  type TaxRegistration,
  type TaxRegistrationKind,
} from '@/src/lib/profile/tax-registrations';

interface Props {
  profileDid: string;
}

interface DraftState {
  jurisdiction: string;
  kind: TaxRegistrationKind;
  number: string;
  label: string;
}

const INPUT_CLASSES =
  'w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-amber-500 focus:outline-none';

function emptyDraft(): DraftState {
  return { jurisdiction: '', kind: TAX_REGISTRATION_KINDS[0], number: '', label: '' };
}

/**
 * The Tax registrations tab (#2420): list/add/remove `tax_registrations` on
 * the acting business profile. Saves via PUT /profile/api/profile/:did,
 * which replaces the full array (see buildProfileUpdates in that route) —
 * so every save round-trips the complete current list, not a delta.
 */
export default function TaxRegistrationsTab({ profileDid }: Readonly<Props>) {
  const { toast } = useToast();
  const [registrations, setRegistrations] = useState<TaxRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<DraftState>(emptyDraft());
  const [draftError, setDraftError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/profile/api/profile/${encodeURIComponent(profileDid)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setRegistrations(Array.isArray(data.taxRegistrations) ? data.taxRegistrations : []);
      }
    } catch {
      toast.error('Failed to load tax registrations');
    } finally {
      setLoading(false);
    }
  }, [profileDid, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async (next: TaxRegistration[]): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await fetch(`/profile/api/profile/${encodeURIComponent(profileDid)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ taxRegistrations: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to save tax registrations');
        return false;
      }
      setRegistrations(Array.isArray(data.taxRegistrations) ? data.taxRegistrations : next);
      return true;
    } catch {
      toast.error('Failed to save tax registrations');
      return false;
    } finally {
      setSaving(false);
    }
  }, [profileDid, toast]);

  async function handleAdd() {
    setDraftError(null);
    const candidate = {
      jurisdiction: draft.jurisdiction.trim(),
      kind: draft.kind,
      number: draft.number.trim(),
      label: draft.label.trim() || undefined,
    };
    const validation = validateTaxRegistration(candidate);
    if (!validation.valid || !validation.normalized) {
      setDraftError(validation.error ?? 'Invalid tax registration');
      return;
    }
    const ok = await save([...registrations, validation.normalized]);
    if (ok) {
      setAdding(false);
      setDraft(emptyDraft());
      toast.success('Tax registration added');
    }
  }

  async function handleRemove(index: number) {
    const ok = await save(registrations.filter((_, i) => i !== index));
    if (ok) toast.success('Tax registration removed');
  }

  if (loading) {
    return <div className="text-zinc-500 text-sm py-8">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Tax registrations</h2>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-medium rounded-lg transition-colors"
          >
            + Add registration
          </button>
        )}
      </div>

      <p className="text-xs text-zinc-600">
        Registration numbers print on invoices and pay pages next to the tax line. Format is checked locally — numbers are never verified against a tax authority.
      </p>

      {adding && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
          {draftError && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{draftError}</div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="tax-reg-jurisdiction" className="block text-xs text-zinc-500 mb-1.5">
                Jurisdiction
              </label>
              <input
                id="tax-reg-jurisdiction"
                type="text"
                value={draft.jurisdiction}
                onChange={(e) => setDraft((d) => ({ ...d, jurisdiction: e.target.value }))}
                placeholder="CA-ON"
                className={INPUT_CLASSES}
              />
            </div>
            <div>
              <label htmlFor="tax-reg-kind" className="block text-xs text-zinc-500 mb-1.5">
                Kind
              </label>
              <select
                id="tax-reg-kind"
                value={draft.kind}
                onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as TaxRegistrationKind }))}
                className={INPUT_CLASSES}
              >
                {TAX_REGISTRATION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="tax-reg-number" className="block text-xs text-zinc-500 mb-1.5">
              Registration number
            </label>
            <input
              id="tax-reg-number"
              type="text"
              value={draft.number}
              onChange={(e) => setDraft((d) => ({ ...d, number: e.target.value }))}
              placeholder="123456789RT0001"
              className={INPUT_CLASSES}
            />
          </div>
          <div>
            <label htmlFor="tax-reg-label" className="block text-xs text-zinc-500 mb-1.5">
              Label (optional)
            </label>
            <input
              id="tax-reg-label"
              type="text"
              value={draft.label}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              placeholder="Head office"
              className={INPUT_CLASSES}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAdd}
              disabled={saving}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-700 text-black text-sm font-medium rounded-lg transition-colors"
            >
              {saving ? 'Saving…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setDraft(emptyDraft()); setDraftError(null); }}
              disabled={saving}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {registrations.length === 0 ? (
        <p className="text-sm text-zinc-500">No tax registrations on file.</p>
      ) : (
        <ul className="space-y-2">
          {registrations.map((reg, index) => (
            <li
              key={`${reg.jurisdiction}-${reg.kind}-${reg.number}`}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 flex items-center justify-between"
            >
              <div>
                <p className="text-sm text-white font-medium">
                  {reg.kind} · {reg.jurisdiction}
                </p>
                <p className="text-xs text-zinc-500 font-mono">{reg.number}</p>
                {reg.label && <p className="text-xs text-zinc-600">{reg.label}</p>}
              </div>
              <button
                type="button"
                onClick={() => handleRemove(index)}
                disabled={saving}
                aria-label={`Remove ${reg.kind} registration for ${reg.jurisdiction}`}
                className="text-zinc-500 hover:text-red-400 text-sm px-2 disabled:opacity-50"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
