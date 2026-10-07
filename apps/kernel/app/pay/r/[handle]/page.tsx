import { notFound } from 'next/navigation';
import { getPaymentRequestInvoiceByHandle } from '@/src/lib/pay/payment-requests/service';
import type { PaymentRequestInvoiceView } from '@/src/lib/pay/payment-requests/service';
import { formatMinorUnits } from '@/src/lib/pay/payment-requests/money-format';
import { formatInvoiceDate, settlementRefLabel } from '@/src/lib/pay/payment-requests/invoice';
import { formatRateBps } from '@/src/lib/pay/payment-requests/tax-rates';
import type { PaymentRequestTaxLine } from '@/src/lib/pay/payment-requests/types';
import BilledTo from './BilledTo';
import PayRequestActions from './PayRequestActions';
import PrintInvoiceButton from './PrintInvoiceButton';
import './invoice-print.css';

const STATUS_NOTES: Record<string, string> = {
  paid: 'This has already been paid.',
  settled_manual: 'This has already been settled.',
};

function StatusNote({ status }: Readonly<{ status: string }>) {
  // `emt_pending` (#2665) is still an open request: the actions block shows the e-Transfer instructions.
  if (status === 'issued' || status === 'emt_pending') return null;
  return (
    <div data-print="hide" className="text-sm text-center text-zinc-500 bg-black/30 border border-zinc-800 rounded-lg px-3 py-2">
      {STATUS_NOTES[status] ?? 'This payment request is no longer active.'}
    </div>
  );
}

interface TaxBreakdownProps {
  subtotalAmount: number;
  taxes: PaymentRequestTaxLine[];
  currency: string;
}

/**
 * Subtotal → tax lines (#2421), rendered only for a request that charges
 * tax. Each tax line shows kind, jurisdiction, rate and the issuer's
 * registration number next to the amount — the number prints on invoices by
 * design (#2420). The grand total renders below, as it always has.
 */
function TaxBreakdown({ subtotalAmount, taxes, currency }: Readonly<TaxBreakdownProps>) {
  return (
    <div className="space-y-2 border-t border-zinc-800 pt-4 text-sm text-zinc-300" data-testid="tax-breakdown" data-invoice-row>
      <div className="flex justify-between">
        <span>Subtotal</span>
        <span>{formatMinorUnits(subtotalAmount, currency)}</span>
      </div>
      {taxes.map((tax) => (
        <div key={`${tax.kind}-${tax.jurisdiction}`} className="flex justify-between gap-4" data-invoice-row>
          <span>
            {tax.kind} ({tax.jurisdiction}) · {formatRateBps(tax.rateBps)}
            <span className="invoice-muted block text-xs text-zinc-500">Registration no. {tax.registrationNumber}</span>
          </span>
          <span>{formatMinorUnits(tax.amount, currency)}</span>
        </div>
      ))}
    </div>
  );
}

const PAID_STATUSES = new Set(['paid', 'settled_manual']);

function isPaid(view: Pick<PaymentRequestInvoiceView, 'status'>): boolean {
  return PAID_STATUSES.has(view.status);
}

/** Document title above the issuer's name: a receipt once paid, otherwise the request's kind. */
function documentLabel(view: PaymentRequestInvoiceView): string {
  if (isPaid(view)) return 'Receipt from';
  return view.kind === 'invoice' ? 'Invoice from' : 'Payment request from';
}

/** `Issued`, or `Paid on 2026-10-06` once settled (`Paid` when no payment date was recorded). */
function statusLabel(view: PaymentRequestInvoiceView): string {
  if (!isPaid(view)) return 'Issued';
  return view.paidAt ? `Paid on ${formatInvoiceDate(view.paidAt)}` : 'Paid';
}

/** Rubber-stamp style PAID mark — on screen and in print, once settled. */
function PaidStamp() {
  return (
    <div
      data-testid="paid-stamp"
      className="invoice-stamp -rotate-6 border-4 border-green-500 text-green-500 rounded-md px-4 py-1 text-2xl font-extrabold tracking-widest uppercase"
    >
      Paid
    </div>
  );
}

interface MetaRowProps {
  label: string;
  value: string;
  testId: string;
}

function MetaRow({ label, value, testId }: Readonly<MetaRowProps>) {
  return (
    <div className="flex justify-between gap-4" data-testid={testId}>
      <dt className="invoice-muted text-zinc-500">{label}</dt>
      <dd className="text-zinc-200 text-right">{value}</dd>
    </div>
  );
}

/** Document number, issue and due dates (calendar dates, UTC — #2651), currency and status. */
function InvoiceMeta({ view }: Readonly<{ view: PaymentRequestInvoiceView }>) {
  return (
    <dl className="space-y-1 text-sm" data-testid="invoice-meta" data-invoice-row>
      <MetaRow label="Invoice no." value={view.invoiceNumber} testId="invoice-number" />
      {view.issuedAt && <MetaRow label="Issued" value={formatInvoiceDate(view.issuedAt)} testId="invoice-issued" />}
      {view.dueAt && <MetaRow label="Due" value={formatInvoiceDate(view.dueAt)} testId="invoice-due" />}
      <MetaRow label="Currency" value={view.currency} testId="invoice-currency" />
      <MetaRow label="Status" value={statusLabel(view)} testId="invoice-status" />
    </dl>
  );
}

/** Receipt details once paid: payment date and settlement reference. */
function ReceiptDetails({ view }: Readonly<{ view: PaymentRequestInvoiceView }>) {
  return (
    <dl className="space-y-1 border-t border-zinc-800 pt-4 text-sm" data-testid="receipt-details" data-invoice-row>
      {view.paidAt && <MetaRow label="Payment date" value={formatInvoiceDate(view.paidAt)} testId="receipt-paid-date" />}
      {view.settlement && (
        <MetaRow label="Settlement ref" value={settlementRefLabel(view.settlement)} testId="receipt-settlement-ref" />
      )}
      {view.paidBy && <MetaRow label="Paid by" value={view.paidBy.displayName} testId="receipt-paid-by" />}
      {view.paidBy && <MetaRow label="Paying DID" value={view.paidBy.did} testId="receipt-paid-by-did" />}
    </dl>
  );
}

function LineItems({ view }: Readonly<{ view: PaymentRequestInvoiceView }>) {
  return (
    <div className="space-y-1">
      {view.lineItems.map((item, i) => (
        <div key={`${item.name}-${i}`} className="text-sm text-zinc-300" data-invoice-row>
          <div className="flex justify-between">
            <span>
              {item.name}
              {item.quantity > 1 ? ` × ${item.quantity}` : ''}
            </span>
            <span>{formatMinorUnits(item.amount * item.quantity, view.currency)}</span>
          </div>
          {item.description && <p className="invoice-muted text-xs text-zinc-500">{item.description}</p>}
        </div>
      ))}
    </div>
  );
}

/**
 * /pay/r/:handle — the public pay page for a payment_request's opaque
 * `pay_handle` (#2210/#2211), which doubles as the printable invoice and,
 * once paid, the receipt (#2661). Unauthenticated: renders exactly what
 * `getPaymentRequestInvoiceByHandle` returns (issuer name and public business
 * address, line items, subtotal/tax lines when tax is charged, total, status,
 * document number and dates, and — once paid — the payment date and settlement
 * ref) — never a DID or the recipient (the optional "Billed to" is typed by the
 * payer and stays in the browser). `void` requests 404 the same as an unknown
 * handle. The print layout is `invoice-print.css`.
 */
export default async function PayByHandlePage({ params }: Readonly<{ params: Promise<{ handle: string }> }>) {
  const { handle } = await params;
  const view = await getPaymentRequestInvoiceByHandle(handle);
  if (!view) {
    notFound();
  }

  const paid = isPaid(view);

  return (
    <div className="invoice-page max-w-lg mx-auto py-12 px-4 space-y-3">
      <PrintInvoiceButton />

      <div className="invoice-sheet bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-6">
        <div className="flex items-start justify-between gap-4" data-invoice-row>
          <div>
            <p className="invoice-muted text-xs text-zinc-500 uppercase tracking-wider">{documentLabel(view)}</p>
            <h1 className="text-xl font-bold text-white mt-1">{view.issuerDisplayName}</h1>
            {view.issuerAddress && (
              <p className="invoice-muted text-sm text-zinc-400 whitespace-pre-line mt-1" data-testid="issuer-address">
                {view.issuerAddress}
              </p>
            )}
          </div>
          {paid && <PaidStamp />}
        </div>

        <InvoiceMeta view={view} />

        <BilledTo />

        <LineItems view={view} />

        {view.taxes.length > 0 && (
          <TaxBreakdown subtotalAmount={view.subtotalAmount} taxes={view.taxes} currency={view.currency} />
        )}

        <div className="flex justify-between items-baseline border-t border-zinc-800 pt-4" data-invoice-row>
          <span className="invoice-muted text-sm text-zinc-400">{paid ? 'Total paid' : 'Total due'}</span>
          <span className="text-2xl font-bold text-white">{formatMinorUnits(view.totalAmount, view.currency)}</span>
        </div>

        {paid && <ReceiptDetails view={view} />}

        <StatusNote status={view.status} />

        <div data-print="hide">
          <PayRequestActions handle={handle} status={view.status} emt={view.emt ?? null} />
        </div>
      </div>
    </div>
  );
}
