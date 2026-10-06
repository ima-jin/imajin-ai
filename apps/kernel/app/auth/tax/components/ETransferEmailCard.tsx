'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@imajin/ui';
import { validateEtransferEmail } from '@/src/lib/profile/etransfer-email';

interface Props {
  profileDid: string;
}

const INPUT_CLASSES =
  'w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-amber-500 focus:outline-none';

/**
 * The e-Transfer receiving email (#2665), owner-editable next to the tax
 * registrations. The "Pay by e-Transfer" option on a payment request's pay
 * page appears only while this is set; clearing it turns the option off.
 * Reads via the owner-only `GET /profile/api/profile/:did/etransfer-email`
 * (the public profile read withholds it) and saves via `PUT
 * /profile/api/profile/:did`.
 */
export default function ETransferEmailCard({ profileDid }: Readonly<Props>) {
  const { toast } = useToast();
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/profile/api/profile/${encodeURIComponent(profileDid)}/etransfer-email`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const email = typeof data.etransferEmail === 'string' ? data.etransferEmail : null;
        setSaved(email);
        setDraft(email ?? '');
      }
    } catch {
      toast.error('Failed to load e-Transfer email');
    } finally {
      setLoading(false);
    }
  }, [profileDid, toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    setError(null);
    const validation = validateEtransferEmail(draft);
    if (!validation.valid) {
      setError(validation.error ?? 'Invalid e-Transfer email');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/profile/api/profile/${encodeURIComponent(profileDid)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ etransferEmail: validation.normalized }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to save e-Transfer email');
        return;
      }
      const next = typeof data.etransferEmail === 'string' ? data.etransferEmail : null;
      setSaved(next);
      setDraft(next ?? '');
      toast.success(next ? 'e-Transfer email saved' : 'e-Transfer turned off');
    } catch {
      setError('Failed to save e-Transfer email');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-zinc-500 text-sm py-4">Loading…</div>;
  }

  const unchanged = draft.trim().toLowerCase() === (saved ?? '');

  return (
    <div className="space-y-3 bg-zinc-900 border border-zinc-800 rounded-xl p-5" data-testid="etransfer-email-card">
      <h2 className="text-xl font-bold text-white">Interac e-Transfer</h2>
      <p className="text-xs text-zinc-600">
        Payers see &ldquo;Pay by e-Transfer&rdquo; on your payment requests only while a receiving email is set. It is shown
        to a payer only after they choose e-Transfer, never on your public profile. Clear it to turn e-Transfer off.
      </p>
      {error && <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</div>}
      <div>
        <label htmlFor="etransfer-email" className="block text-xs text-zinc-500 mb-1.5">
          e-Transfer receiving email
        </label>
        <input
          id="etransfer-email"
          type="email"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="payments@yourbusiness.ca"
          className={INPUT_CLASSES}
        />
      </div>
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || unchanged}
        className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-700 text-black text-sm font-medium rounded-lg transition-colors"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
