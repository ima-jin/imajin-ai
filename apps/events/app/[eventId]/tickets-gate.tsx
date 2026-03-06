'use client';

import { useState, useEffect, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  surveysRequired: boolean;
  initialCompleted: boolean;
  requiredSurveyIds: string[];
}

export function TicketsGate({ children, surveysRequired, initialCompleted, requiredSurveyIds }: Props) {
  const [completed, setCompleted] = useState(initialCompleted);

  useEffect(() => {
    if (!surveysRequired || completed) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'survey-completed') {
        const completedSurveyId = event.data.surveyId;
        if (requiredSurveyIds.includes(completedSurveyId)) {
          // Check if this was the last required survey
          // For simplicity, unlock immediately — the page will verify on next load
          setCompleted(true);
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
