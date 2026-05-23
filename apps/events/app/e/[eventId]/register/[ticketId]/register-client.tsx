'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetch } from '@imajin/config';
import { SurveyAccordion } from '../../survey-accordion';

interface Props {
  ticketId: string;
  eventId: string;
  registrationFormId: string | null;
}

export default function RegisterClient({ ticketId, eventId, registrationFormId }: Readonly<Props>) {
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const router = useRouter();

  async function handleRegistrationComplete() {
    setIsRetrying(true);
    setError(null);

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await apiFetch(`/api/register/${ticketId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ formId: registrationFormId }),
        });

        if (res.ok) {
          setIsComplete(true);
          setIsRetrying(false);
          return;
        }

        // Idempotent: 409 means already complete
        if (res.status === 409) {
          setIsComplete(true);
          setIsRetrying(false);
          return;
        }

        const data = await res.json().catch(() => ({}));
        const msg = data.error || `Registration failed (${res.status})`;

        // 404 = Dykil survey_responses row not inserted yet (race condition)
        if (res.status === 404 && attempt < maxRetries) {
          const backoff = 500 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }

        // Other client errors — don't retry
        if (res.status >= 400 && res.status < 500) {
          setError(msg);
          setIsRetrying(false);
          return;
        }

        // Server error — retry with backoff
        if (attempt === maxRetries) {
          setError(msg);
          setIsRetrying(false);
          return;
        }
        const backoff = 500 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Registration failed';
        if (attempt === maxRetries) {
          setError(msg);
          setIsRetrying(false);
          return;
        }
        const backoff = 500 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
      }
    }

    setIsRetrying(false);
  }

  if (isComplete) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 text-center">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-2xl font-bold mb-2">{"You're registered!"}</h2>
        <p className="text-gray-600 dark:text-gray-400">
          Your ticket has been registered. See you there!
        </p>
        <Link
          href={`/e/${eventId}`}
          className="mt-6 inline-block px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition"
        >
          Go to Event →
        </Link>
      </div>
    );
  }

  // No Dykil form attached — show a message instead of a broken form
  if (!registrationFormId) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 text-center">
        <div className="text-4xl mb-4">🎫</div>
        <h2 className="text-xl font-bold mb-2">Registration Form Unavailable</h2>
        <p className="text-gray-600 dark:text-gray-400">
          Please visit the event page to complete your registration.
        </p>
        <Link
          href={`/e/${eventId}`}
          className="mt-6 inline-block px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition"
        >
          Go to Event →
        </Link>
      </div>
    );
  }

  return (
    <div>
      <SurveyAccordion
        eventId={eventId}
        surveyId={registrationFormId}
        surveyTitle="Complete Registration"
        surveyType="form"
        defaultExpanded={true}
        ticketId={ticketId}
        initialCompleted={false}
        onComplete={handleRegistrationComplete}
      />

      {error && (
        <div className="mt-4 flex items-center gap-3 justify-center">
          <span className="text-sm text-red-500">{error}</span>
          <button
            onClick={handleRegistrationComplete}
            disabled={isRetrying}
            className="px-3 py-1 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 transition"
          >
            {isRetrying ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      )}
    </div>
  );
}
