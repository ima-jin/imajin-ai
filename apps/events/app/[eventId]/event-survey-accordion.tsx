'use client';

import { useState, useEffect, useRef } from 'react';

interface EventSurveyAccordionProps {
  eventId: string;
  surveyId: string;
  surveyTitle: string;
  surveyType?: 'pre-event' | 'post-event' | 'survey' | 'form';
  requiresTicket?: boolean;
}

export function EventSurveyAccordion({
  eventId,
  surveyId,
  surveyTitle,
  surveyType,
  requiresTicket = false,
}: EventSurveyAccordionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(600);
  const [isCompleted, setIsCompleted] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const DYKIL_URL = process.env.NEXT_PUBLIC_DYKIL_URL || 'https://dykil.imajin.ai';
  const embedUrl = `${DYKIL_URL}/embed/${surveyId}`;

  // Listen for postMessage from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Validate origin for security
      if (!event.origin.includes('dykil')) return;

      if (event.data.type === 'survey-height') {
        setIframeHeight(event.data.height + 40); // Add some padding
      } else if (event.data.type === 'survey-completed') {
        setIsCompleted(true);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const icon = '📋';

  return (
    <div className="bg-white dark:bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-lg overflow-hidden">
      {/* Collapsed Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800/80 transition"
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl">{icon}</span>
          <div className="text-left">
            <span className="font-semibold text-lg block">{surveyTitle}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isCompleted && (
            <span className="px-3 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-semibold rounded-full">
              ✓ Completed
            </span>
          )}
          <span className={`text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
            ▼
          </span>
        </div>
      </button>

      {/* Expanded Survey */}
      {isExpanded && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          {requiresTicket ? (
            <div className="p-8 text-center">
              <div className="text-4xl mb-4">🎟️</div>
              <h3 className="text-xl font-bold mb-2">Ticket Required</h3>
              <p className="text-gray-600 dark:text-gray-400">
                Purchase a ticket to access this survey.
              </p>
            </div>
          ) : isCompleted && !showEditForm ? (
            <div className="p-8 text-center">
              <div className="text-6xl mb-4">✓</div>
              <h3 className="text-2xl font-bold mb-2">Thank you!</h3>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                Your response has been recorded. You can now purchase tickets below.
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => setIsExpanded(false)}
                  className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition text-sm font-medium"
                >
                  View Tickets ↓
                </button>
                <button
                  onClick={() => setShowEditForm(true)}
                  className="px-4 py-2 text-gray-500 hover:text-gray-300 transition text-sm"
                >
                  Edit answers
                </button>
              </div>
            </div>
          ) : (
            <div className="p-0">
              <iframe
                ref={iframeRef}
                src={embedUrl}
                className="w-full border-0"
                style={{ height: `${iframeHeight}px`, minHeight: '400px' }}
                title={surveyTitle}
                allow="clipboard-write"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
