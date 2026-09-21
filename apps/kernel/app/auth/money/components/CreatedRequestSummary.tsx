'use client';

import { buildPublicUrl } from '@imajin/config';
import CopyButton from './CopyButton';
import type { PaymentRequestRow } from '../lib/types';

interface Props {
  row: PaymentRequestRow;
  onDone: () => void;
}

/**
 * Shown immediately after a successful create (#2211): the opaque
 * by-handle pay-link + invite link (if any) with copy buttons, the issued
 * attestation id (submitting IS the signing gesture — canvas is
 * authoritative), and the resulting `.fair` split, read-only (the
 * custom-manifest editor is out of scope; this is always the server's
 * default single-payee manifest).
 */
export default function CreatedRequestSummary({ row, onDone }: Readonly<Props>) {
  const payUrl = `${buildPublicUrl('pay')}/r/${row.payHandle}`;

  return (
    <div className="bg-zinc-900 border border-amber-500/30 rounded-xl p-5 space-y-4">
      <div>
        <h3 className="text-lg font-bold text-white">Payment request sent</h3>
        <p className="text-xs text-zinc-500 mt-1">
          Signed attestation: <span className="font-mono text-zinc-400">{row.attestationId ?? '—'}</span>
        </p>
      </div>

      <div>
        <span className="block text-xs text-zinc-500 mb-1.5">Pay link</span>
        <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-3 py-2">
          <code className="text-xs text-amber-300 flex-1 truncate">{payUrl}</code>
          <CopyButton text={payUrl} label="Copy pay link" />
        </div>
      </div>

      {row.invite && (
        <div>
          <span className="block text-xs text-zinc-500 mb-1.5">Invite link</span>
          <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-lg px-3 py-2">
            <code className="text-xs text-amber-300 flex-1 truncate">{row.invite.url}</code>
            <CopyButton text={row.invite.url} label="Copy invite link" />
          </div>
        </div>
      )}

      <div>
        <span className="block text-xs text-zinc-500 mb-1.5">Split (.fair manifest)</span>
        <div className="space-y-1 text-xs text-zinc-500">
          {row.fairManifest.chain.map((entry, i) => (
            <div key={`${entry.role}-${i}`} className="flex justify-between">
              <span className="capitalize">{entry.role}</span>
              <span>{(entry.share * 100).toFixed(2)}%</span>
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={onDone}
        className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-medium rounded-lg transition-colors"
      >
        Done
      </button>
    </div>
  );
}
