'use client';

import { useState, useEffect, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  surveysRequired: boolean;
  initialCompleted: boolean;
  requiredSurveyIds: string[];
}

const DYKIL_URL = process.env.NEXT_PUBLIC_DYKIL_URL || 'https://dykil.imajin.ai';

async function checkSurveyCompletion(surveyId: string): Promise<boolean> {
  try {
    const res = await fetch(`${DYKIL_URL}/api/surveys/${surveyId}/responses/check`, {
      credentials: 'include',
    });
    if (res.ok) {
      const data = await res.json();
      return data.completed === true;
    }
  } catch {}
  return false;
}

export function TicketsGate({ children, surveysRequired, initialCompleted, requiredSurveyIds }: Props) {
  const [completed, setCompleted] = useState(initialCompleted);
  const [checking, setChecking] = useState(false);

  // Reconcile if localStorage hints at completion but SSR says incomplete
  useEffect(() => {
    if (completed || !surveysRequired) return;

    const hasLocalHints = requiredSurveyIds.some(id =>
      localStorage.getItem(`survey_${id}_completed`) === 'true'
    );
    if (!hasLocalHints) return;

    // Poll authoritative state for each required survey
    setChecking(true);
    Promise.all(
      requiredSurveyIds.map(async (surveyId) => {
        // Prefer authoritative check; fallback to localStorage on failure
        const authoritative = await checkSurveyCompletion(surveyId);
        if (authoritative) return true;
        return localStorage.getItem(`survey_${surveyId}_completed`) === 'true';
      })
    ).then((results) => {
      if (results.every(Boolean)) {
        setCompleted(true);
      }
      setChecking(false);
    });
  }, [completed, surveysRequired, requiredSurveyIds]);

  useEffect(() => {
    if (!surveysRequired || completed) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'survey-completed') {
        const completedSurveyId = event.data.surveyId;
        if (requiredSurveyIds.includes(completedSurveyId)) {
          localStorage.setItem(`survey_${completedSurveyId}_completed`, 'true');
          // Refetch authoritative state instead of trusting localStorage
          checkSurveyCompletion(completedSurveyId)
            .then((isDone) => {
              if (isDone) {
                // Check if all required surveys are now done
                Promise.all(
                  requiredSurveyIds.map(async (id) => {
                    if (id === completedSurveyId) return true;
                    const done = await checkSurveyCompletion(id);
                    if (done) return true;
                    return localStorage.getItem(`survey_${id}_completed`) === 'true';
                  })
                ).then((checks) => {
                  if (checks.every(Boolean)) setCompleted(true);
                });
              }
            })
            .catch(() => {
              // Fallback: trust localStorage on network error
              const allDone = requiredSurveyIds.every(id =>
                id === completedSurveyId || localStorage.getItem(`survey_${id}_completed`) === 'true'
              );
              if (allDone) setCompleted(true);
            });
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [surveysRequired, completed, requiredSurveyIds]);

  if (!surveysRequired || completed) {
    return <>{children}</>;
  }

  return (
    <div className="text-center py-12">
      <div className="text-5xl mb-4">📋</div>
      <p className="text-lg font-semibold mb-2">Complete the registration form first</p>
      <p className="text-gray-500 dark:text-gray-400 text-sm">
        Please fill out the required survey above before purchasing tickets.
      </p>
      {checking && <p className="text-xs text-gray-400 mt-2">Checking status...</p>}
    </div>
  );
}
