'use client';

import { useState } from 'react';
import { useToast } from '@imajin/ui';
import LineItemsEditor from './LineItemsEditor';
import RecipientPicker, { type RecipientMode } from './RecipientPicker';
import CreatedRequestSummary from './CreatedRequestSummary';
import { buildCreatePaymentRequestBody, type CreateFormState } from '../lib/build-create-request';
import type { LineItemDraft, PaymentRequestRow, RecipientInviteDraft, SelectedConnection } from '../lib/types';

interface Props {
  issuerDid: string;
  onCreated: (row: PaymentRequestRow) => void;
  onCancel: () => void;
}

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP'];
const SELECT_CLASSES =
  'w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none';

function newLineItem(): LineItemDraft {
  const key = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `item-${Date.now()}`;
  return { key, name: '', description: '', quantity: '1', unitAmount: '' };
}

/**
 * The create flow for a payment_request (#2211). Submitting IS the
 * signing gesture — the canvas is authoritative, so there's no separate
 * confirm/sign step here; success shows the issued attestation id via
 * {@link CreatedRequestSummary}. The optional custom `.fair` manifest
 * editor is out of scope — `fair_manifest` is never sent, so the server
 * always builds the default single-payee manifest.
 */
export default function CreatePaymentRequestForm({ issuerDid, onCreated, onCancel }: Readonly<Props>) {
  const { toast } = useToast();
  const [kind, setKind] = useState<'invoice' | 'request'>('invoice');
  const [currency, setCurrency] = useState('CAD');
  const [lineItems, setLineItems] = useState<LineItemDraft[]>([newLineItem()]);
  const [dueAt, setDueAt] = useState('');
  const [allowOnPlatform, setAllowOnPlatform] = useState(true);
  const [recipientMode, setRecipientMode] = useState<RecipientMode>('connection');
  const [selectedConnection, setSelectedConnection] = useState<SelectedConnection | null>(null);
  const [invite, setInvite] = useState<RecipientInviteDraft>({ email: '', delivery: 'email', note: '' });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<PaymentRequestRow | null>(null);

  async function handleSubmit() {
    setError(null);
    const state: CreateFormState = {
      kind,
      currency,
      lineItems,
      dueAt,
      allowOnPlatform,
      recipientMode,
      selectedConnection,
      invite,
    };
    const validation = buildCreatePaymentRequestBody(issuerDid, state);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/pay/api/payment-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(validation.body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to create payment request');
        return;
      }
      setCreated(data);
      toast.success('Payment request created');
    } catch {
      setError('Failed to create payment request');
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return <CreatedRequestSummary row={created} onDone={() => onCreated(created)} />;
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-white">New payment request</h3>
        <button type="button" onClick={onCancel} className="text-zinc-500 hover:text-zinc-300 text-sm">
          ✕
        </button>
      </div>

      {error && <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="pr-kind" className="block text-xs text-zinc-500 mb-1.5">
            Kind
          </label>
          <select id="pr-kind" value={kind} onChange={(e) => setKind(e.target.value as 'invoice' | 'request')} className={SELECT_CLASSES}>
            <option value="invoice">Invoice</option>
            <option value="request">Request</option>
          </select>
        </div>
        <div>
          <label htmlFor="pr-currency" className="block text-xs text-zinc-500 mb-1.5">
            Currency
          </label>
          <select id="pr-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={SELECT_CLASSES}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <span className="block text-xs text-zinc-500 mb-1.5">Line items</span>
        <LineItemsEditor items={lineItems} currency={currency} onChange={setLineItems} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="pr-due-at" className="block text-xs text-zinc-500 mb-1.5">
            Due date (optional)
          </label>
          <input
            id="pr-due-at"
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
          />
        </div>
        <div className="flex items-end pb-2">
          <label htmlFor="pr-allow-on-platform" className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              id="pr-allow-on-platform"
              type="checkbox"
              checked={allowOnPlatform}
              onChange={(e) => setAllowOnPlatform(e.target.checked)}
            />
            Allow payment on platform
          </label>
        </div>
      </div>

      <div>
        <span className="block text-xs text-zinc-500 mb-1.5">Recipient</span>
        <RecipientPicker
          mode={recipientMode}
          onModeChange={setRecipientMode}
          selectedConnection={selectedConnection}
          onSelectConnection={setSelectedConnection}
          invite={invite}
          onInviteChange={setInvite}
        />
      </div>

      <p className="text-xs text-zinc-600">
        Sending is the signing gesture — this issues a signed <code>payment_request.issued</code> attestation.
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-700 text-black text-sm font-medium rounded-lg transition-colors"
        >
          {submitting ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
