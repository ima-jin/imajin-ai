'use client';

import { useState } from 'react';
import { useToast } from '@imajin/ui';
import { buildPublicUrl } from '@imajin/config';
import { formatMinorUnits } from '@/src/lib/pay/payment-requests/money-format';
import CopyButton from './CopyButton';
import type { PaymentRequestRow, PaymentRequestStatus } from '../lib/types';

interface Props {
  row: PaymentRequestRow;
  onChanged: () => void;
}

const STATUS_BADGES: Record<PaymentRequestStatus, { label: string; classes: string }> = {
  issued: { label: 'Issued', classes: 'bg-amber-900/30 text-amber-400 border-amber-800' },
  paid: { label: 'Paid', classes: 'bg-green-900/30 text-green-400 border-green-800' },
  settled_manual: { label: 'Settled (manual)', classes: 'bg-green-900/30 text-green-400 border-green-800' },
  void: { label: 'Void', classes: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
};

/** Row detail's recipient label (#2211): the resolved DID, or "Pending claim" while addressed to a not-yet-claimed stub. */
function recipientLabel(row: PaymentRequestRow): string {
  return row.recipientDid ?? 'Pending claim';
}

export default function PaymentRequestRowItem({ row, onChanged }: Readonly<Props>) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [settling, setSettling] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const badge = STATUS_BADGES[row.status];
  const payUrl = `${buildPublicUrl('pay')}/r/${row.payHandle}`;
  const canAct = row.status === 'issued';

  async function handleSettle() {
    setSubmitting(true);
    try {
      const res = await fetch(`/pay/api/payment-requests/${row.id}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ method: 'manual', ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to mark as settled');
        return;
      }
      toast.success('Marked as settled');
      setSettling(false);
      setNote('');
      onChanged();
    } catch {
      toast.error('Failed to mark as settled');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVoid() {
    if (!globalThis.confirm('Void this payment request? This cannot be undone.')) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/pay/api/payment-requests/${row.id}/void`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to void');
        return;
      }
      toast.success('Payment request voided');
      onChanged();
    } catch {
      toast.error('Failed to void');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-zinc-800/40 transition-colors"
      >
        <span className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${badge.classes}`}>{badge.label}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-zinc-200 truncate capitalize">
            {row.kind} · {formatMinorUnits(row.totalAmount, row.currency)}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5 truncate">
            {recipientLabel(row)}
            {row.dueAt && <span className="ml-2">· due {new Date(row.dueAt).toLocaleDateString()}</span>}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t border-zinc-800/60 space-y-4 pt-4">
          <div>
            <h4 className="text-xs font-medium text-zinc-400 mb-2 uppercase tracking-wider">Line items</h4>
            <div className="space-y-1">
              {row.lineItems.map((item, i) => (
                <div key={`${item.name}-${i}`} className="flex justify-between text-sm text-zinc-300">
                  <span>
                    {item.name}
                    {item.quantity > 1 ? ` × ${item.quantity}` : ''}
                  </span>
                  <span>{formatMinorUnits(item.amount * item.quantity, row.currency)}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <span className="block text-xs text-zinc-500 mb-1.5">Pay link</span>
            <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-3 py-2">
              <code className="text-xs text-amber-300 flex-1 truncate">{payUrl}</code>
              <CopyButton text={payUrl} label="Copy pay link" />
            </div>
          </div>

          <div>
            <h4 className="text-xs font-medium text-zinc-400 mb-2 uppercase tracking-wider">Split (.fair manifest)</h4>
            <div className="space-y-1 text-xs text-zinc-500">
              {row.fairManifest.chain.map((entry, i) => (
                <div key={`${entry.role}-${i}`} className="flex justify-between">
                  <span className="capitalize">{entry.role}</span>
                  <span>{(entry.share * 100).toFixed(2)}%</span>
                </div>
              ))}
            </div>
          </div>

          <div className="text-xs text-zinc-600 space-y-1">
            <div className="flex gap-2">
              <span className="w-28 shrink-0">Settlement ref</span>
              <span>
                {row.settlementRef
                  ? `${row.settlementRef.method}${row.settlementRef.note ? ` — ${row.settlementRef.note}` : ''}`
                  : '—'}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="w-28 shrink-0">Attestation</span>
              <span className="font-mono">{row.attestationId ?? '—'}</span>
            </div>
          </div>

          {canAct && (
            <div className="pt-2 border-t border-zinc-800/60">
              {settling ? (
                <div className="space-y-2">
                  <label htmlFor={`settle-note-${row.id}`} className="block text-xs text-zinc-500">
                    Settlement note (optional)
                  </label>
                  <textarea
                    id={`settle-note-${row.id}`}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder="e.g. Paid via e-transfer"
                    className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-amber-500 focus:outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleSettle}
                      disabled={submitting}
                      className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-700 text-black text-xs font-medium rounded-lg transition-colors"
                    >
                      {submitting ? 'Confirming…' : 'Confirm settled'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSettling(false);
                        setNote('');
                      }}
                      disabled={submitting}
                      className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setSettling(true)}
                    disabled={submitting}
                    className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg transition-colors"
                  >
                    Mark settled (off-platform)
                  </button>
                  <button
                    type="button"
                    onClick={handleVoid}
                    disabled={submitting}
                    className="px-3 py-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-300 text-xs font-medium rounded-lg transition-colors"
                  >
                    Void
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
