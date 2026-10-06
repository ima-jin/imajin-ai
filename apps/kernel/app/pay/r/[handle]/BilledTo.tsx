'use client';

import { useState } from 'react';

/**
 * Optional "Billed to" for the printed invoice (#2661).
 *
 * The pay page deliberately holds no recipient data (no PII behind the opaque
 * handle), so the payer can type the name or company to print on their copy.
 * It lives only in this component's state — never sent to the server, never
 * stored. The input is screen-only; the typed value prints as plain text.
 */
export default function BilledTo() {
  const [value, setValue] = useState('');
  const billedTo = value.trim();

  return (
    <div data-invoice-row>
      <div data-print="hide">
        <label htmlFor="billed-to" className="block text-xs text-zinc-500 mb-1">
          Billed to (optional — prints on your copy, never saved)
        </label>
        <input
          id="billed-to"
          type="text"
          value={value}
          maxLength={200}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your name or company"
          className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-amber-500 focus:outline-none"
        />
      </div>
      {billedTo && (
        <div className="hidden print:block" data-testid="billed-to-print">
          <p className="invoice-muted text-xs text-zinc-500 uppercase tracking-wider">Billed to</p>
          <p className="text-sm text-zinc-200">{billedTo}</p>
        </div>
      )}
    </div>
  );
}
