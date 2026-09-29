'use client';

import { formatMinorUnits } from '@/src/lib/pay/payment-requests/money-format';
import { formatRateBps } from '@/src/lib/pay/payment-requests/tax-rates';
import type { TaxPreviewResult } from '../lib/tax-form';
import type { TaxRowDraft } from '../lib/types';

interface Props {
  chargeTax: boolean;
  onChargeTaxChange: (next: boolean) => void;
  rows: TaxRowDraft[];
  onRowsChange: (rows: TaxRowDraft[]) => void;
  /** `null` while the line items are incomplete (no subtotal to compute tax on yet). */
  preview: TaxPreviewResult | null;
  currency: string;
  /** false until the issuer's profile registrations have been read. */
  loaded: boolean;
}

const RATE_INPUT_CLASSES =
  'w-24 bg-black border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:border-amber-500 focus:outline-none';

function SummaryRow({ label, value, strong }: Readonly<{ label: string; value: string; strong?: boolean }>) {
  return (
    <div className={`flex justify-between ${strong ? 'text-white font-semibold' : 'text-zinc-300'}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** Subtotal, tax rate, tax amount and total — shown while "Charge tax" is on (#2421). */
function TaxSummary({ preview, currency }: Readonly<{ preview: TaxPreviewResult | null; currency: string }>) {
  if (!preview) {
    return <p className="text-xs text-zinc-600">Enter the line items to see the subtotal, tax and total.</p>;
  }
  if (!preview.ok) {
    return <p className="text-xs text-red-400">{preview.error}</p>;
  }

  const { subtotal, rows, taxTotal, total } = preview.value;
  const rateLabel = rows.map((row) => `${row.kind} ${formatRateBps(row.rateBps)}`).join(' + ');
  return (
    <div className="space-y-1 text-sm bg-black/30 border border-zinc-800 rounded-lg px-3 py-2" data-testid="tax-summary">
      <SummaryRow label="Subtotal" value={formatMinorUnits(subtotal, currency)} />
      <SummaryRow label="Tax rate" value={rateLabel} />
      <SummaryRow label="Tax amount" value={formatMinorUnits(taxTotal, currency)} />
      <SummaryRow label="Total" value={formatMinorUnits(total, currency)} strong />
    </div>
  );
}

/**
 * The "Charge tax" section of the create form (#2421). Default ON when the
 * issuer has a tax registration on their business profile; one row per
 * registration with an editable rate, prefilled from the static default-rate
 * table (blank — and required — when there is no integer-bps default). The
 * server recomputes everything shown here.
 */
export default function TaxSection({ chargeTax, onChargeTaxChange, rows, onRowsChange, preview, currency, loaded }: Readonly<Props>) {
  const hasRegistrations = rows.length > 0;

  function updateRow(key: string, patch: Partial<TaxRowDraft>) {
    onRowsChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-3">
      <label htmlFor="pr-charge-tax" className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          id="pr-charge-tax"
          type="checkbox"
          checked={chargeTax}
          disabled={!loaded || !hasRegistrations}
          onChange={(e) => onChargeTaxChange(e.target.checked)}
        />
        <span>Charge tax</span>
      </label>

      {loaded && !hasRegistrations && (
        <p className="text-xs text-zinc-600">
          Add a tax registration on your business profile (Tax tab) to charge tax — its number prints next to the tax line.
        </p>
      )}

      {chargeTax && (
        <>
          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.key} className="flex items-center gap-3 text-sm">
                <label htmlFor={`tax-included-${row.key}`} className="flex items-center gap-2 flex-1 text-zinc-300">
                  <input
                    id={`tax-included-${row.key}`}
                    type="checkbox"
                    checked={row.included}
                    onChange={(e) => updateRow(row.key, { included: e.target.checked })}
                  />
                  <span>
                    {row.kind} ({row.jurisdiction})
                    <span className="block text-xs text-zinc-500">Reg. {row.number}</span>
                  </span>
                </label>
                <label htmlFor={`tax-rate-${row.key}`} className="sr-only">
                  {`Rate for ${row.kind} (${row.jurisdiction}), percent`}
                </label>
                <input
                  id={`tax-rate-${row.key}`}
                  type="text"
                  inputMode="decimal"
                  value={row.rate}
                  disabled={!row.included}
                  onChange={(e) => updateRow(row.key, { rate: e.target.value })}
                  placeholder="Rate"
                  className={RATE_INPUT_CLASSES}
                />
                <span className="text-zinc-500 text-sm">%</span>
              </div>
            ))}
          </div>
          <TaxSummary preview={preview} currency={currency} />
        </>
      )}
    </div>
  );
}
