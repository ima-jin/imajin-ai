'use client';

import { useEffect } from 'react';

/** `?print=1` — set by the issuer row's link so the print dialog opens as soon as the invoice has rendered. */
const AUTO_PRINT_PARAM = 'print';

/**
 * "Print / Download PDF" for the pay page's invoice (#2661). PDF generation is
 * the browser's own print-to-PDF ("Save as PDF" in the print dialog) against
 * the print layout in `invoice-print.css` — no server-side PDF dependency.
 * Screen-only: `data-print="hide"` keeps it off the printed page.
 */
export default function PrintInvoiceButton() {
  useEffect(() => {
    if (new URLSearchParams(globalThis.location.search).get(AUTO_PRINT_PARAM) !== '1') return;
    const frame = globalThis.requestAnimationFrame(() => globalThis.print());
    return () => globalThis.cancelAnimationFrame(frame);
  }, []);

  return (
    <div data-print="hide" className="flex items-center justify-end gap-3">
      <span className="text-xs text-zinc-500">Choose “Save as PDF” in the print dialog to download.</span>
      <button
        type="button"
        onClick={() => globalThis.print()}
        className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg transition-colors"
      >
        Print / Download PDF
      </button>
    </div>
  );
}
