'use client';

import { useEffect, useState } from 'react';

/** One DID the signed-in payer may pay as — `GET /pay/api/payment-requests/:handle/payer-dids` (#2656). */
export interface PayerDidOptionView {
  did: string;
  kind: 'personal' | 'organization';
  displayName: string;
}

interface PayerDidChoicesView {
  dids: PayerDidOptionView[];
  defaultDid: string;
}

function isOptionView(value: unknown): value is PayerDidOptionView {
  if (typeof value !== 'object' || value === null) return false;
  const option = value as Record<string, unknown>;
  return typeof option.did === 'string' && typeof option.displayName === 'string';
}

/** The picker data from a response body, or `null` for anything that isn't one (e.g. an unrelated 200). */
function parseChoices(body: unknown): PayerDidChoicesView | null {
  if (typeof body !== 'object' || body === null) return null;
  const { dids, defaultDid } = body as { dids?: unknown; defaultDid?: unknown };
  if (!Array.isArray(dids) || dids.length === 0 || !dids.every(isOptionView)) return null;
  const fallback = dids[0].did;
  return { dids, defaultDid: typeof defaultDid === 'string' && dids.some((d) => d.did === defaultDid) ? defaultDid : fallback };
}

export interface PayerDidPicker {
  /** Empty until the payer is known to be signed in — an anonymous payer never sees the picker. */
  dids: PayerDidOptionView[];
  /** The chosen DID, or `null` while there is no picker (nothing is sent, so the request settles as its recipient). */
  paidByDid: string | null;
  setPaidByDid: (did: string) => void;
}

/**
 * Loads the DIDs the signed-in payer may pay as. A 401 (anonymous payer), any
 * failure, or an unexpected body leaves the picker empty — the page then behaves
 * exactly as it did before #2656. The server re-validates whatever is sent, so
 * this is only the offer, never the enforcement.
 */
export function usePayerDids(handle: string): PayerDidPicker {
  const [dids, setDids] = useState<PayerDidOptionView[]>([]);
  const [paidByDid, setPaidByDid] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/pay/api/payment-requests/${encodeURIComponent(handle)}/payer-dids`);
        if (!res.ok) return;
        const choices = parseChoices(await res.json());
        if (!choices || cancelled) return;
        setDids(choices.dids);
        setPaidByDid(choices.defaultDid);
      } catch {
        // Anonymous / offline: no picker.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [handle]);

  return { dids, paidByDid, setPaidByDid };
}

function optionLabel(option: PayerDidOptionView): string {
  return option.kind === 'personal' ? `${option.displayName} (you)` : option.displayName;
}

/** "Pay as: Eric / Artifact" — a select when there is a choice, plain text when the payer has only themselves. */
export default function PayAsPicker({ picker }: Readonly<{ picker: PayerDidPicker }>) {
  const { dids, paidByDid, setPaidByDid } = picker;
  if (dids.length === 0) return null;

  if (dids.length === 1) {
    return (
      <div className="text-sm text-zinc-400" data-testid="pay-as-single">
        Paying as <span className="text-zinc-100 font-medium">{dids[0].displayName}</span>
      </div>
    );
  }

  return (
    <div className="space-y-1" data-testid="pay-as">
      <label htmlFor="pay-as-select" className="block text-xs text-zinc-500">
        Pay as
      </label>
      <select
        id="pay-as-select"
        value={paidByDid ?? ''}
        onChange={(e) => setPaidByDid(e.target.value)}
        className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
      >
        {dids.map((option) => (
          <option key={option.did} value={option.did}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </div>
  );
}
