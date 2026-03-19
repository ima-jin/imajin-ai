'use client';

import { useState, useEffect, useRef } from 'react';
import { SurveyAccordion } from '../survey-accordion';

interface Props {
  ticketId: string;
  eventId: string;
  ticketTypeName: string;
  pricePaid: number | null;
  currency: string | null;
  purchasedAt: string | null;
  registrationStatus: string;
  registrationFormId: string | null;
  registration: { name: string; email: string } | null;
  qrCodeDataUri?: string;
  autoExpand: boolean;
}

export function MyTicketCard({
  ticketId,
  eventId,
  ticketTypeName,
  pricePaid,
  currency,
  purchasedAt,
  registrationStatus: initialStatus,
  registrationFormId,
  registration,
  qrCodeDataUri,
  autoExpand,
}: Props) {
  const [regStatus, setRegStatus] = useState(initialStatus);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoExpand && ref.current) {
      setTimeout(() => {
        ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [autoExpand]);

  const formattedPrice =
    pricePaid !== null && currency
      ? pricePaid === 0
        ? 'Free'
        : new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(pricePaid / 100)
      : null;

  const formattedDate = purchasedAt
    ? new Date(purchasedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  const isPending = regStatus === 'pending';
  const isComplete = regStatus === 'complete';

  const borderClass = isPending
    ? 'border-yellow-400 dark:border-yellow-500'
    : isComplete
    ? 'border-green-500 dark:border-green-500'
    : 'border-orange-500 dark:border-orange-500';

  const bgClass = isPending
    ? 'bg-yellow-50/30 dark:bg-yellow-900/5'
    : isComplete
    ? 'bg-green-50/30 dark:bg-green-900/5'
    : 'bg-orange-50/30 dark:bg-orange-900/5';

  async function markRegistered() {
    try {
      await fetch(`/api/register/${ticketId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formId: registrationFormId }),
      });
      setRegStatus('complete');
    } catch {
      // Non-fatal — survey is already saved in Dykil
    }
  }

  return (
    <div ref={ref} className={`rounded-2xl border-2 overflow-hidden ${borderClass} ${bgClass}`}>
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-bold">{ticketTypeName}</h2>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {formattedPrice && (
                <span className="text-sm text-gray-500 dark:text-gray-400">{formattedPrice}</span>
              )}
              {formattedDate && (
                <span className="text-sm text-gray-400">📅 {formattedDate}</span>
              )}
            </div>
            <p className="font-mono text-[10px] text-gray-400 mt-0.5">{ticketId}</p>
          </div>
          <RegistrationBadge status={regStatus} />
        </div>

        {/* Completed: show attendee info + QR */}
        {isComplete && (
          <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
            {registration && (
              <div className="flex-1">
                <div className="p-3 bg-gray-100 dark:bg-gray-700/50 rounded-xl">
                  <p className="font-semibold">{registration.name}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{registration.email}</p>
                </div>
              </div>
            )}
            {qrCodeDataUri && (
              <div className="bg-gray-900 dark:bg-[#0a0a0a] border border-gray-700 rounded-xl p-3 text-center flex-shrink-0">
                <img
                  src={qrCodeDataUri}
                  alt="Ticket QR Code"
                  width={140}
                  height={140}
                  className="mx-auto mb-1"
                />
                <p className="font-mono text-[9px] text-gray-400">{ticketId}</p>
              </div>
            )}
          </div>
        )}

        {/* Not required: show QR only */}
        {!isPending && !isComplete && qrCodeDataUri && (
          <div className="flex justify-center">
            <div className="bg-gray-900 dark:bg-[#0a0a0a] border border-gray-700 rounded-xl p-3 text-center">
              <img
                src={qrCodeDataUri}
                alt="Ticket QR Code"
                width={140}
                height={140}
                className="mx-auto mb-1"
              />
              <p className="font-mono text-[9px] text-gray-400">{ticketId}</p>
            </div>
          </div>
        )}
      </div>

      {/* Registration survey — reuses SurveyAccordion */}
      {registrationFormId && (
        <SurveyAccordion
          eventId={eventId}
          surveyId={registrationFormId}
          surveyTitle={isPending ? 'Complete Registration' : 'Registration'}
          surveyType="form"
          defaultExpanded={autoExpand}
          onComplete={markRegistered}
        />
      )}
    </div>
  );
}

function RegistrationBadge({ status }: { status: string }) {
  if (status === 'complete') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 whitespace-nowrap flex-shrink-0">
        ✅ Registered
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400 whitespace-nowrap flex-shrink-0">
        ⏳ Registration Required
      </span>
    );
  }
  return null;
}
