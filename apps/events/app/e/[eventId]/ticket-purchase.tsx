'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TicketType } from '@/src/db/schema';
import { apiFetch } from '@imajin/config';

interface Props {
  eventId: string;
  eventTitle: string;
  ticket: TicketType;
  inviteToken?: string;
  etransferEnabled?: boolean;
  stripeDisabled?: boolean;
  maxPerOrder?: number;
  sessionEmail?: string;
  quantity?: number;
  onQuantityChange?: (qty: number) => void;
  hideCheckoutButton?: boolean;
}

interface ETransferInstructions {
  ticketId: string;
  email: string;
  amount: number;
  currency: string;
  memo: string;
  deadline: string;
  message: string;
}

type Step = 'button' | 'selector' | 'loading-card' | 'etransfer-confirm' | 'loading-etransfer' | 'etransfer-done' | 'rsvp-form' | 'loading-rsvp' | 'rsvp-done';

type TriState = 'loading' | 'disabled' | 'active';

type PrimaryAction = 'rsvp' | 'etransfer' | 'selector' | 'card';

// ---- pure helpers ----

export function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

export function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function computeAvailableCount(ticket: Pick<TicketType, 'quantity' | 'sold'>): number | null {
  return ticket.quantity === null ? null : ticket.quantity - (ticket.sold ?? 0);
}

export function isSoldOut(ticket: Pick<TicketType, 'quantity' | 'sold'>): boolean {
  return ticket.quantity !== null && (ticket.sold ?? 0) >= ticket.quantity;
}

export function computeEffectiveMax(ticket: TicketType, maxPerOrder: number | undefined): number {
  // Effective max: per-type override > prop > default 10, capped at 20
  const resolvedMax = maxPerOrder ?? (ticket as any).maxPerOrder ?? 10;
  const availableCount = computeAvailableCount(ticket);
  return Math.min(resolvedMax, availableCount ?? 20, 20);
}

export function resolveTriState(isLoading: boolean, isDisabled: boolean): TriState {
  if (isLoading) return 'loading';
  if (isDisabled) return 'disabled';
  return 'active';
}

const FORM_ACTION_BUTTON_CLASSNAMES: Record<TriState, string> = {
  loading: 'bg-orange-400 text-white cursor-wait',
  disabled: 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed',
  active: 'bg-orange-500 text-white hover:bg-orange-600',
};

const MAIN_CTA_BUTTON_CLASSNAMES: Record<TriState, string> = {
  loading: 'bg-orange-400 text-white cursor-wait',
  disabled: 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed',
  active: 'bg-orange-500 text-white hover:bg-orange-600',
};

export function resolvePrimaryAction(isFree: boolean, stripeDisabled: boolean, etransferEnabled: boolean): PrimaryAction {
  if (isFree) return 'rsvp';
  if (stripeDisabled && etransferEnabled) return 'etransfer';
  if (etransferEnabled) return 'selector';
  return 'card';
}

export function mainCtaLabel(step: Step, isFree: boolean, stripeDisabled: boolean, etransferEnabled: boolean, quantity: number): string {
  if ((step as string) === 'loading-rsvp') return 'Confirming...';
  if (isFree) return 'RSVP';
  if (stripeDisabled && etransferEnabled) return '🏦 Pay by e-Transfer';
  if (quantity > 1) return `Get ${quantity} Tickets`;
  if (quantity === 0) return 'Select quantity';
  return 'Get Ticket';
}

// ---- checkout actions hook ----

interface UseCheckoutActionsArgs {
  eventId: string;
  ticket: TicketType;
  inviteToken?: string;
  etransferEnabled: boolean;
  isFree: boolean;
}

function useCheckoutActions({ eventId, ticket, inviteToken, etransferEnabled, isFree }: UseCheckoutActionsArgs) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('button');
  const [error, setError] = useState<string | null>(null);
  const [etransfer, setEtransfer] = useState<ETransferInstructions | null>(null);

  const handleCardPayment = async (quantity: number) => {
    setStep('loading-card');
    setError(null);

    try {
      const response = await apiFetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          ticketTypeId: ticket.id,
          quantity,
          ...(inviteToken && { invite: inviteToken }),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create checkout');
      }

      const { url } = await response.json();
      globalThis.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setStep(etransferEnabled ? 'selector' : 'button');
    }
  };

  const handleETransfer = async (quantity: number, email: string, name: string) => {
    setStep('loading-etransfer');
    setError(null);

    try {
      const response = await apiFetch('/api/checkout/etransfer', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          ticketTypeId: ticket.id,
          quantity: Math.max(1, quantity || 1),
          ...(inviteToken && { invite: inviteToken }),
          ...(email && { email: email.trim() }),
          ...(name && { name: name.trim() }),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create e-Transfer hold');
      }

      const data = await response.json();
      setEtransfer({
        ticketId: data.orderId || data.ticketId,
        email: data.instructions.email,
        amount: data.instructions.amount,
        currency: data.instructions.currency,
        memo: data.instructions.memo,
        deadline: data.instructions.deadline,
        message: data.instructions.message,
      });
      setStep('etransfer-done');
      // Refresh server data so 'My Tickets' tab appears
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setStep('selector');
    }
  };

  const handleFreeRsvp = async (email: string, name: string, withEmail?: boolean) => {
    setStep('loading-rsvp');
    setError(null);

    try {
      const response = await apiFetch('/api/checkout/free', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          eventId,
          ticketTypeId: ticket.id,
          ...(inviteToken && { invite: inviteToken }),
          ...(withEmail && email && { email: email.trim() }),
          ...(withEmail && name && { name: name.trim() }),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        if (response.status === 409) {
          // Already has a ticket — treat as success
          setStep('rsvp-done');
          return;
        }
        if (response.status === 400 && data.error?.includes('email')) {
          // Not logged in, need email — show form
          setStep('rsvp-form');
          return;
        }
        throw new Error(data.error || 'RSVP failed');
      }

      setStep('rsvp-done');
      // Refresh server data so 'My Tickets' tab appears
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setStep(isFree ? 'rsvp-form' : 'button');
    }
  };

  return { step, setStep, error, setError, etransfer, handleCardPayment, handleETransfer, handleFreeRsvp };
}

// ---- step views ----

function RsvpDoneView() {
  return (
    <div className="flex items-center gap-2">
      <span className="text-green-500 text-xl">✅</span>
      <span className="font-semibold text-green-600 dark:text-green-400">You&apos;re in!</span>
    </div>
  );
}

interface RsvpFormViewProps {
  eventTitle: string;
  sessionEmail?: string;
  name: string;
  setName: (name: string) => void;
  email: string;
  setEmail: (email: string) => void;
  isLoading: boolean;
  error: string | null;
  onConfirm: () => void;
  onBack: () => void;
}

function RsvpFormView({ eventTitle, sessionEmail, name, setName, email, setEmail, isLoading, error, onConfirm, onBack }: Readonly<RsvpFormViewProps>) {
  const confirmClassName = FORM_ACTION_BUTTON_CLASSNAMES[resolveTriState(isLoading, !email.includes('@'))];

  return (
    <div className="w-full max-w-md rounded-xl border border-orange-500/30 bg-orange-500/5 dark:bg-orange-500/10 p-5 space-y-4">
      <h3 className="font-semibold text-base">📬 RSVP — {eventTitle}</h3>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {sessionEmail ? 'Confirm your RSVP.' : 'Enter your details to reserve your free spot.'}
      </p>
      <div className="space-y-2">
        {!sessionEmail && (
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isLoading}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 disabled:opacity-50"
          />
        )}
        {sessionEmail ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Confirmation will be sent to <span className="font-medium">{sessionEmail}</span>
          </p>
        ) : (
          <input
            type="email"
            placeholder="Your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isLoading}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 disabled:opacity-50"
          />
        )}
      </div>
      <div className="flex gap-2">
        <button type="button"
          onClick={onConfirm}
          disabled={isLoading || !email.includes('@')}
          className={`px-5 py-2.5 rounded-lg font-semibold transition whitespace-nowrap ${confirmClassName}`}
        >
          {isLoading ? 'Confirming...' : 'Confirm RSVP'}
        </button>
        <button type="button"
          onClick={onBack}
          disabled={isLoading}
          className="px-3 py-2.5 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition disabled:opacity-50"
        >
          Back
        </button>
      </div>
      {error && <p className="text-red-500 text-xs">{error}</p>}
    </div>
  );
}

function SoldOutView() {
  return (
    <button type="button"
      disabled
      className="px-6 md:px-8 py-2.5 md:py-3 rounded-lg font-semibold whitespace-nowrap bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed"
    >
      Sold Out
    </button>
  );
}

function EtransferDoneView({ etransfer }: Readonly<{ etransfer: ETransferInstructions }>) {
  return (
    <div className="w-full max-w-md rounded-xl border border-orange-500/30 bg-orange-500/5 dark:bg-orange-500/10 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-orange-500 text-xl">📬</span>
        <h3 className="font-semibold text-base">Reserved — send your e-Transfer to confirm</h3>
      </div>
      <p className="text-xs text-orange-500">
        You don't have your ticket yet. It'll be activated once we confirm your payment — we'll email you the ticket then.
      </p>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between items-center py-2 border-b border-gray-200 dark:border-gray-700">
          <span className="text-gray-500 dark:text-gray-400">Amount</span>
          <span className="font-semibold text-base">
            {new Intl.NumberFormat('en-CA', { style: 'currency', currency: etransfer.currency }).format(etransfer.amount)}
          </span>
        </div>
        <div className="flex justify-between items-center py-2 border-b border-gray-200 dark:border-gray-700">
          <span className="text-gray-500 dark:text-gray-400">Send your e-Transfer to</span>
          <span className="font-mono font-medium">{etransfer.email}</span>
        </div>
        <div className="flex justify-between items-center py-2 border-b border-gray-200 dark:border-gray-700">
          <span className="text-gray-500 dark:text-gray-400">Required memo</span>
          <span className="font-mono font-semibold text-orange-500">{etransfer.memo}</span>
        </div>
        <div className="flex justify-between items-center py-2">
          <span className="text-gray-500 dark:text-gray-400">Pay by</span>
          <span className="font-medium">{formatDeadline(etransfer.deadline)}</span>
        </div>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-lg p-3">
        {etransfer.message}
      </p>

      <p className="text-xs text-gray-400">
        Ticket ID: <span className="font-mono">{etransfer.ticketId}</span>
      </p>
    </div>
  );
}

interface EtransferConfirmViewProps {
  ticket: TicketType;
  sessionEmail?: string;
  name: string;
  setName: (name: string) => void;
  email: string;
  setEmail: (email: string) => void;
  isLoading: boolean;
  error: string | null;
  onReserve: () => void;
  onBack: () => void;
}

function EtransferConfirmView({ ticket, sessionEmail, name, setName, email, setEmail, isLoading, error, onReserve, onBack }: Readonly<EtransferConfirmViewProps>) {
  const reserveClassName = FORM_ACTION_BUTTON_CLASSNAMES[resolveTriState(isLoading, !email.includes('@'))];

  return (
    <div className="w-full max-w-md rounded-xl border border-orange-500/30 bg-orange-500/5 dark:bg-orange-500/10 p-5 space-y-4">
      <h3 className="font-semibold text-base">🏦 Pay by Interac e-Transfer</h3>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        You&apos;ll need to send <span className="font-semibold">{formatPrice(ticket.price, ticket.currency)}</span> via
        Interac e-Transfer within 72 hours. Your ticket will be held until payment is confirmed.
      </p>
      <div className="space-y-2">
        {!sessionEmail && (
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isLoading}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 disabled:opacity-50"
          />
        )}
        {sessionEmail ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Confirmation will be sent to <span className="font-medium">{sessionEmail}</span>
          </p>
        ) : (
          <input
            type="email"
            placeholder="Your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isLoading}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 disabled:opacity-50"
          />
        )}
      </div>
      <div className="flex gap-2">
        <button type="button"
          onClick={onReserve}
          disabled={isLoading || !email.includes('@')}
          className={`px-5 py-2.5 rounded-lg font-semibold transition whitespace-nowrap ${reserveClassName}`}
        >
          {isLoading ? 'Reserving...' : 'Reserve My Ticket'}
        </button>
        <button type="button"
          onClick={onBack}
          disabled={isLoading}
          className="px-3 py-2.5 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition disabled:opacity-50"
        >
          Back
        </button>
      </div>
      {error && <p className="text-red-500 text-xs">{error}</p>}
    </div>
  );
}

interface SelectorViewProps {
  error: string | null;
  showQuantity: boolean;
  quantity: number;
  setQuantity: (q: number) => void;
  effectiveMax: number;
  ticket: TicketType;
  stripeDisabled: boolean;
  etransferEnabled: boolean;
  isLoadingCard: boolean;
  onCardPayment: () => void;
  onEtransferStart: () => void;
  onCancel: () => void;
}

function SelectorView({
  error,
  showQuantity,
  quantity,
  setQuantity,
  effectiveMax,
  ticket,
  stripeDisabled,
  etransferEnabled,
  isLoadingCard,
  onCardPayment,
  onEtransferStart,
  onCancel,
}: Readonly<SelectorViewProps>) {
  return (
    <div className="space-y-2">
      {error && <p className="text-red-500 text-xs">{error}</p>}
      {showQuantity && <QuantityStepper quantity={quantity} setQuantity={setQuantity} max={effectiveMax} price={ticket.price} currency={ticket.currency} />}
      <div className="flex flex-col gap-2 w-full">
        {!stripeDisabled && (
          <button type="button"
            onClick={onCardPayment}
            disabled={isLoadingCard}
            className={`w-full px-4 py-2.5 rounded-lg font-semibold transition text-center ${
              isLoadingCard
                ? 'bg-orange-400 text-white cursor-wait'
                : 'bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50'
            }`}
          >
            {isLoadingCard ? 'Loading...' : '💳 Pay with Card'}
          </button>
        )}
        {etransferEnabled && (
          <div className="flex flex-col gap-1">
            <button type="button"
              onClick={onEtransferStart}
              disabled={isLoadingCard}
              className="w-full px-4 py-2.5 rounded-lg font-semibold transition text-center bg-orange-500/20 text-orange-500 border border-orange-500/40 hover:bg-orange-500/30 disabled:opacity-50"
            >
              🏦 Pay by e-Transfer
            </button>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              e-Transfer payments go directly to the event organizer. Refunds are handled between you and the organizer.
            </p>
          </div>
        )}
        <button type="button"
          onClick={onCancel}
          disabled={isLoadingCard}
          className="px-3 py-2.5 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

interface DefaultViewProps {
  error: string | null;
  showQuantity: boolean;
  quantity: number;
  setQuantity: (q: number) => void;
  effectiveMax: number;
  ticket: TicketType;
  hideCheckoutButton: boolean;
  isFree: boolean;
  stripeDisabled: boolean;
  etransferEnabled: boolean;
  step: Step;
  onButtonClick: () => void;
}

function DefaultView({
  error,
  showQuantity,
  quantity,
  setQuantity,
  effectiveMax,
  ticket,
  hideCheckoutButton,
  isFree,
  stripeDisabled,
  etransferEnabled,
  step,
  onButtonClick,
}: Readonly<DefaultViewProps>) {
  const isLoadingRsvp = (step as string) === 'loading-rsvp';
  const isDisabled = isLoadingRsvp || (!isFree && quantity === 0);
  const buttonClassName = MAIN_CTA_BUTTON_CLASSNAMES[resolveTriState(isLoadingRsvp, !isFree && quantity === 0)];
  const label = mainCtaLabel(step, isFree, stripeDisabled, etransferEnabled, quantity);

  return (
    <>
      {error && (
        <p className="text-red-500 text-xs mb-2">{error}</p>
      )}
      {showQuantity && <QuantityStepper quantity={quantity} setQuantity={setQuantity} max={effectiveMax} price={ticket.price} currency={ticket.currency} />}
      {!hideCheckoutButton && (
        <button type="button"
          onClick={onButtonClick}
          disabled={isDisabled}
          className={`px-6 md:px-8 py-2.5 md:py-3 rounded-lg font-semibold transition whitespace-nowrap ${buttonClassName}`}
        >
          {label}
        </button>
      )}
    </>
  );
}

export function TicketPurchase({ eventId, eventTitle, ticket, inviteToken, etransferEnabled = false, stripeDisabled = false, maxPerOrder, sessionEmail, quantity: externalQty, onQuantityChange, hideCheckoutButton = false }: Readonly<Props>) {
  const [email, setEmail] = useState(sessionEmail || '');
  const [name, setName] = useState('');
  const [internalQty, setInternalQty] = useState(0);

  // Use external quantity if controlled by parent, otherwise internal
  const quantity = externalQty ?? internalQty;
  const setQuantity = (q: number) => {
    if (onQuantityChange) onQuantityChange(q);
    else setInternalQty(q);
  };

  const isFree = ticket.price === 0;
  const soldOut = isSoldOut(ticket);
  const effectiveMax = computeEffectiveMax(ticket, maxPerOrder);
  const showQuantity = !isFree && effectiveMax >= 1;

  const { step, setStep, error, setError, etransfer, handleCardPayment, handleETransfer, handleFreeRsvp } = useCheckoutActions({
    eventId,
    ticket,
    inviteToken,
    etransferEnabled,
    isFree,
  });

  const primaryActionHandlers: Record<PrimaryAction, () => void> = {
    rsvp: () => { handleFreeRsvp(email, name, false).catch(() => setStep('rsvp-form')); },
    etransfer: () => setStep('etransfer-confirm'),
    selector: () => setStep('selector'),
    card: () => handleCardPayment(quantity),
  };
  const handleButtonClick = () => primaryActionHandlers[resolvePrimaryAction(isFree, stripeDisabled, etransferEnabled)]();

  const clearErrorAndSetStep = (nextStep: Step) => {
    setStep(nextStep);
    setError(null);
  };

  if (step === 'rsvp-done') {
    return <RsvpDoneView />;
  }

  if (step === 'rsvp-form' || step === 'loading-rsvp') {
    return (
      <RsvpFormView
        eventTitle={eventTitle}
        sessionEmail={sessionEmail}
        name={name}
        setName={setName}
        email={email}
        setEmail={setEmail}
        isLoading={step === 'loading-rsvp'}
        error={error}
        onConfirm={() => handleFreeRsvp(email, name, true)}
        onBack={() => clearErrorAndSetStep('button')}
      />
    );
  }

  if (soldOut) {
    return <SoldOutView />;
  }

  if (step === 'etransfer-done' && etransfer) {
    return <EtransferDoneView etransfer={etransfer} />;
  }

  if (step === 'etransfer-confirm' || step === 'loading-etransfer') {
    return (
      <EtransferConfirmView
        ticket={ticket}
        sessionEmail={sessionEmail}
        name={name}
        setName={setName}
        email={email}
        setEmail={setEmail}
        isLoading={step === 'loading-etransfer'}
        error={error}
        onReserve={() => handleETransfer(quantity, email, name)}
        onBack={() => clearErrorAndSetStep('selector')}
      />
    );
  }

  if (step === 'selector' || step === 'loading-card') {
    return (
      <SelectorView
        error={error}
        showQuantity={showQuantity}
        quantity={quantity}
        setQuantity={setQuantity}
        effectiveMax={effectiveMax}
        ticket={ticket}
        stripeDisabled={stripeDisabled}
        etransferEnabled={etransferEnabled}
        isLoadingCard={step === 'loading-card'}
        onCardPayment={() => handleCardPayment(quantity)}
        onEtransferStart={() => setStep('etransfer-confirm')}
        onCancel={() => clearErrorAndSetStep('button')}
      />
    );
  }

  return (
    <DefaultView
      error={error}
      showQuantity={showQuantity}
      quantity={quantity}
      setQuantity={setQuantity}
      effectiveMax={effectiveMax}
      ticket={ticket}
      hideCheckoutButton={hideCheckoutButton}
      isFree={isFree}
      stripeDisabled={stripeDisabled}
      etransferEnabled={etransferEnabled}
      step={step}
      onButtonClick={handleButtonClick}
    />
  );
}

function QuantityStepper({ quantity, setQuantity, max, price, currency }: Readonly<{
  quantity: number;
  setQuantity: (q: number) => void;
  max: number;
  price: number;
  currency: string;
}>) {
  const total = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
  }).format((price * quantity) / 100);

  return (
    <div className="flex items-center gap-3 mb-2">
      <div className="flex items-center border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
        <button type="button"
          onClick={() => setQuantity(Math.max(0, quantity - 1))}
          disabled={quantity <= 0}
          className="px-3 py-1.5 text-lg font-bold hover:bg-gray-100 dark:hover:bg-gray-800 transition disabled:opacity-30 disabled:cursor-not-allowed"
        >
          −
        </button>
        <span className="px-3 py-1.5 min-w-[2.5rem] text-center font-semibold text-sm border-x border-gray-300 dark:border-gray-600">
          {quantity}
        </span>
        <button type="button"
          onClick={() => setQuantity(Math.min(max, quantity + 1))}
          disabled={quantity >= max}
          className="px-3 py-1.5 text-lg font-bold hover:bg-gray-100 dark:hover:bg-gray-800 transition disabled:opacity-30 disabled:cursor-not-allowed"
        >
          +
        </button>
      </div>
      {quantity > 0 && (
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {quantity > 1 ? `${total} total` : total}
        </span>
      )}
    </div>
  );
}
