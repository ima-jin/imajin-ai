'use client';

import { useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@imajin/config';
import { SurveyAccordion } from '../../survey-accordion';

interface Props {
  ticketId: string;
  eventId: string;
  registrationFormId: string | null;
}

const MAX_REGISTRATION_ATTEMPTS = 3;

type AttemptOutcome =
  | { kind: 'success' }
  | { kind: 'retryable'; message: string }
  | { kind: 'fatal'; message: string };

export function backoffDelayMs(attempt: number): number {
  return 500 * Math.pow(2, attempt - 1);
}

async function attemptRegistration(ticketId: string, registrationFormId: string | null): Promise<AttemptOutcome> {
  const res = await apiFetch(`/api/register/${ticketId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formId: registrationFormId }),
  });

  // Idempotent: success or already-complete (409)
  if (res.ok || res.status === 409) return { kind: 'success' };

  const data = await res.json().catch(() => ({}));
  const message = data.error || `Registration failed (${res.status})`;

  // 404 = Dykil survey_responses row not inserted yet (race condition) — safe to retry.
  // Any non-4xx status (e.g. 5xx) is also treated as transient and retried.
  const isRetryableStatus = res.status === 404 || res.status < 400 || res.status >= 500;
  if (isRetryableStatus) return { kind: 'retryable', message };

  // Other client errors — don't retry
  return { kind: 'fatal', message };
}

function useRegistrationSubmit(ticketId: string, registrationFormId: string | null) {
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  async function submit() {
    setIsRetrying(true);
    setError(null);

    for (let attempt = 1; attempt <= MAX_REGISTRATION_ATTEMPTS; attempt++) {
      const isLastAttempt = attempt === MAX_REGISTRATION_ATTEMPTS;
      try {
        const outcome = await attemptRegistration(ticketId, registrationFormId);

        if (outcome.kind === 'success') {
          setIsComplete(true);
          setIsRetrying(false);
          return;
        }
        if (outcome.kind === 'fatal' || isLastAttempt) {
          setError(outcome.message);
          setIsRetrying(false);
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Registration failed';
        if (isLastAttempt) {
          setError(message);
          setIsRetrying(false);
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
    }

    setIsRetrying(false);
  }

  return { isComplete, error, isRetrying, submit };
}

function RegisteredConfirmation({ eventId }: Readonly<{ eventId: string }>) {
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

function RegistrationFormUnavailable({ eventId }: Readonly<{ eventId: string }>) {
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

export default function RegisterClient({ ticketId, eventId, registrationFormId }: Readonly<Props>) {
  const { isComplete, error, isRetrying, submit } = useRegistrationSubmit(ticketId, registrationFormId);

  if (isComplete) {
    return <RegisteredConfirmation eventId={eventId} />;
  }

  // No Dykil form attached — show a message instead of a broken form
  if (!registrationFormId) {
    return <RegistrationFormUnavailable eventId={eventId} />;
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
        onComplete={submit}
      />

      {error && (
        <div className="mt-4 flex items-center gap-3 justify-center">
          <span className="text-sm text-red-500">{error}</span>
          <button type="button"
            onClick={submit}
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
