'use client';

import { useState, useEffect, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  surveysRequired: boolean;
  initialCompleted: boolean;
  requiredSurveyIds: string[];
}

export function TicketsGate({ children, surveysRequired, initialCompleted, requiredSurveyIds }: Props) {
  const [completed, setCompleted] = useState(() => {
    if (initialCompleted) return true;
    if (!surveysRequired || typeof window === 'undefined') return false;
    // Check localStorage fallback for anonymous users
    return requiredSurveyIds.every(id =>
      localStorage.getItem(`survey_${id}_completed`) === 'true'
    );
  });

  useEffect(() => {
    if (!surveysRequired || completed) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'survey-completed') {
        const completedSurveyId = event.data.surveyId;
        if (requiredSurveyIds.includes(completedSurveyId)) {
          localStorage.setItem(`survey_${completedSurveyId}_completed`, 'true');
          // Check if all required surveys are now done
          const allDone = requiredSurveyIds.every(id =>
            id === completedSurveyId || localStorage.getItem(`survey_${id}_completed`) === 'true'
          );
          if (allDone) setCompleted(true);
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
    </div>
  );
}
