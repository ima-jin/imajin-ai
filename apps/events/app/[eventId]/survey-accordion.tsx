'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface SurveyAccordionProps {
  eventId: string;
  surveyId: string;
  surveyTitle: string;
  surveyType?: 'pre-event' | 'post-event' | 'survey' | 'form';
  requiresTicket?: boolean;
  defaultExpanded?: boolean;
  onComplete?: () => void | Promise<void>;
  ticketId?: string;
  initialCompleted?: boolean;
}

export function SurveyAccordion({
  eventId,
  surveyId,
  surveyTitle,
  surveyType,
  requiresTicket = false,
  defaultExpanded = false,
  onComplete,
  ticketId,
  initialCompleted = false,
}: SurveyAccordionProps) {
  const storageKey = ticketId ? `survey_completed_${surveyId}_${ticketId}` : `survey_completed_${surveyId}`;
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [iframeHeight, setIframeHeight] = useState(600);
  const [isCompleted, setIsCompleted] = useState(initialCompleted);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const DYKIL_URL = process.env.NEXT_PUBLIC_DYKIL_URL || 'https://dykil.imajin.ai';
  const embedUrl = `${DYKIL_URL}/embed/${surveyId}${ticketId ? `?ticketId=${ticketId}` : ''}`;

  // Fetch authoritative registration status from DB
  const fetchStatus = useCallback(async () => {
    if (!ticketId) return;
    try {
      const res = await fetch(`/api/events/${eventId}/tickets/${ticketId}/registration-status`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'complete') {
          setIsCompleted(true);
        }
      }
    } catch {
      // Non-fatal — keep current state
    }
  }, [eventId, ticketId]);

  // On mount / ticketId change: reconcile from server
  useEffect(() => {
    setIsCompleted(initialCompleted);
    if (ticketId) {
      fetchStatus();
    }
  }, [ticketId, initialCompleted, fetchStatus]);

  // localStorage is only an optimistic hint — triggers a refetch, doesn't set state directly
  useEffect(() => {
    try {
      if (localStorage.getItem(storageKey) === 'true' && !isCompleted && ticketId) {
        fetchStatus();
      }
    } catch {}
  }, [storageKey, isCompleted, ticketId, fetchStatus]);

  // Listen for postMessage from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Validate origin for security
      if (!event.origin.includes('dykil')) return;

      if (event.data.type === 'survey-height') {
        setIframeHeight(event.data.height + 40); // Add some padding
      } else if (event.data.type === 'survey-completed') {
        // Store hint for optimistic UI on other components
        try { localStorage.setItem(storageKey, 'true'); } catch {}
        // Call onComplete first (which registers the response in DB),
        // then mark completed and collapse. Don't fetchStatus here —
        // the DB update hasn't happened yet at this point.
        const finish = () => {
          setIsCompleted(true);
          setIsExpanded(false);
        };
        if (onComplete) {
          // onComplete handles the DB write; mark done after it resolves
          Promise.resolve(onComplete()).then(finish).catch(finish);
        } else {
          finish();
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [storageKey, ticketId, eventId, fetchStatus, onComplete]);

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
