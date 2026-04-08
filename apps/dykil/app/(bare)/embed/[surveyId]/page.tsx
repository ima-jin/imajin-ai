'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { apiFetch, apiUrl } from '@imajin/config';
import { Model } from 'survey-core';
import { Survey } from 'survey-react-ui';
import 'survey-core/survey-core.min.css';

/** Apply dark-mode theme to a SurveyJS model */
function applyDarkTheme(model: Model) {
  model.applyTheme({
    cssVariables: {
      '--sjs-primary-backcolor': '#f97316',
      '--sjs-primary-backcolor-dark': '#ea580c',
      '--sjs-primary-backcolor-light': '#fb923c',
      '--sjs-general-backcolor': 'transparent',
      '--sjs-general-backcolor-dim': 'rgba(255,255,255,0.03)',
      '--sjs-general-backcolor-dim-light': 'rgba(255,255,255,0.05)',
      '--sjs-general-forecolor': '#e5e7eb',
      '--sjs-general-forecolor-light': '#9ca3af',
      '--sjs-editor-background': 'rgba(255,255,255,0.08)',
      '--sjs-editor-forecolor': '#e5e7eb',
      '--sjs-editor-forecolor-light': '#9ca3af',
      '--sjs-error-background': 'rgba(239,68,68,0.1)',
      '--sjs-error-forecolor': '#fca5a5',
      '--sjs-border-default': 'rgba(255,255,255,0.1)',
      '--sjs-border-light': 'rgba(255,255,255,0.06)',
      '--sjs-questionpanel-backcolor': 'transparent',
      '--sjs-font-questiontitle-color': '#e5e7eb',
      '--sjs-font-questiondescription-color': '#9ca3af',
      '--sjs-font-editorfontcolor': '#e5e7eb',
    }
  });
}

/** Apply HTML allowlist handler to a SurveyJS model — allows safe formatting tags in questions */
function applyHtmlHandler(model: Model) {
  const allowed = ['a', 'b', 'i', 'em', 'strong', 'br', 'ul', 'ol', 'li', 'p', 'span'];
  model.onTextMarkdown.add((_, options) => {
    const cleaned = options.text
      .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/gi, (match: string, tag: string) => {
        if (allowed.includes(tag.toLowerCase())) {
          if (tag.toLowerCase() === 'a') {
            return match
              .replace(/<a\s/i, '<a target="_blank" rel="noopener noreferrer" ')
              .replace(/target="_blank"\s*target="_blank"/g, 'target="_blank"');
          }
          return match;
        }
        return '';
      });
    options.html = cleaned;
  });
}

/**
 * ReadOnlySurvey — renders a SurveyJS model in display mode with pre-filled answers.
 * Own component so the Model is created once on mount, not on every parent render.
 */
/**
 * EditableSurvey — renders a SurveyJS model pre-filled with answers for editing.
 * Own component so the Model is created once on mount, not on every parent render.
 */
function EditableSurvey({ fields, answers, onSubmit }: { fields: any; answers: Record<string, any>; onSubmit: (answers: Record<string, any>) => Promise<void> }) {
  const modelRef = useRef<Model | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const m = new Model(fields);
    applyDarkTheme(m);
    applyHtmlHandler(m);
    m.showCompleteButton = true;
    m.showCompletedPage = false;
    m.mergeData(answers);
    m.onComplete.add(async (sender) => {
      const data = JSON.parse(JSON.stringify(sender.data));
      await onSubmit(data);
    });
    modelRef.current = m;
    setReady(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready || !modelRef.current) return null;
  return <Survey model={modelRef.current} />;
}

interface SurveyData {
  id: string;
  title: string;
  description?: string;
  fields: any;
  status: string;
}

export default function SurveyEmbedPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { surveyId } = params;
  const respondentDid = searchParams.get('respondentDid');
  const ticketId = searchParams.get('ticketId');

  const [loading, setLoading] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [surveyData, setSurveyData] = useState<SurveyData | null>(null);
  const [surveyModel, setSurveyModel] = useState<Model | null>(null);
  const [savedAnswers, setSavedAnswers] = useState<Record<string, any> | null>(null);
  const surveyModelRef = useRef<Model | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Send height updates to parent iframe
  useEffect(() => {
    const sendHeight = () => {
      if (containerRef.current && window.parent) {
        const height = containerRef.current.scrollHeight;
        window.parent.postMessage(
          { type: 'survey-height', height },
          '*'
        );
      }
    };

    // Send initial height
    sendHeight();

    // Send height on resize
    const resizeObserver = new ResizeObserver(sendHeight);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => resizeObserver.disconnect();
  }, [loading, submitted, surveyData]);

  useEffect(() => {
    fetchSurvey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId]);

  const fetchSurvey = async () => {
    try {
      const res = await apiFetch(`/api/surveys/${surveyId}`, {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        setSurveyData(data);

        // Create SurveyJS model — filter out null elements to prevent crashes
        let surveyJson = typeof data.fields === 'object' && ('elements' in data.fields || 'pages' in data.fields)
          ? data.fields
          : { elements: Array.isArray(data.fields) ? data.fields : [] };

        // Sanitize: remove null elements from pages and top-level
        if (surveyJson.pages) {
          surveyJson = {
            ...surveyJson,
            pages: surveyJson.pages
              .map((page: any) => page ? { ...page, elements: (page.elements || []).filter(Boolean) } : null)
              .filter(Boolean)
              .filter((page: any) => page.elements.length > 0),
          };
        }
        if (surveyJson.elements) {
          surveyJson = { ...surveyJson, elements: surveyJson.elements.filter(Boolean) };
        }

        // Don't create model if there are no questions
        if ((!surveyJson.elements || surveyJson.elements.length === 0) && (!surveyJson.pages || surveyJson.pages.length === 0)) {
          setSurveyData(data);
          return;
        }

        const model = new Model(surveyJson);

        // Hide SurveyJS built-in completion page — we render our own
        model.showCompletedPage = false;

        // Apply dark-mode-safe theme
        applyDarkTheme(model);

        // Allow HTML in question titles/descriptions (for links etc.)
        applyHtmlHandler(model);

        // Check for existing response and pre-fill
        // When ticketId is set, only check by ticket-scoped responseId (not session DID)
        try {
          const storageKey = ticketId ? `survey_${surveyId}_${ticketId}_responseId` : `survey_${surveyId}_responseId`;
          const storedResponseId = localStorage.getItem(storageKey);

          // Ticket-scoped: no stored response means fresh form
          if (ticketId && !storedResponseId) {
            // Skip check — show fresh form for this ticket
          } else {

          const checkUrl = new URL(apiUrl(`/api/surveys/${surveyId}/responses/check`), window.location.origin);
          checkUrl.searchParams.set('include', 'answers');
          if (storedResponseId) checkUrl.searchParams.set('responseId', storedResponseId);
          if (ticketId) checkUrl.searchParams.set('skipDid', 'true');

          const checkRes = await fetch(checkUrl.toString(), { credentials: 'include' });
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            if (checkData.completed && checkData.answers) {
              model.data = checkData.answers;
              if (checkData.responseId) {
                localStorage.setItem(storageKey, checkData.responseId);
              }
              // Show as already completed with pre-filled data
              setSavedAnswers(checkData.answers);
              setSubmitted(true);
              setSurveyData(data);
              surveyModelRef.current = model;
              setSurveyModel(model);
              // Notify parent that survey is already done
              window.parent.postMessage({ type: 'survey-completed', surveyId }, '*');
              return;
            }
          }

          } // end else (has storedResponseId or no ticketId)
        } catch (e) {
          // Non-fatal — just proceed without pre-fill
        }

        // Handle completion — clone data immediately since SurveyJS may mutate the reference
        model.onComplete.add(async (sender) => {
          const answers = JSON.parse(JSON.stringify(sender.data));
          await submitResponse(answers);
        });

        surveyModelRef.current = model;
        setSurveyModel(model);
      } else {
        console.error('Survey not found');
      }
    } catch (error) {
      console.error('Failed to fetch survey:', error);
    } finally {
      setLoading(false);
    }
  };

  const submitResponse = async (data: any) => {
    // Save answers and show completion immediately — don't wait for POST
    setSavedAnswers(data);
    if (surveyModelRef.current) {
      surveyModelRef.current.data = data;
    }
    setSubmitted(true);
    // Notify parent iframe immediately — include answers so host can extract name/email
    window.parent.postMessage(
      { type: 'survey-completed', surveyId, answers: data },
      '*'
    );

    // POST in background — response is already shown to user
    try {
      const res = await apiFetch(`/api/surveys/${surveyId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ answers: data, ...(ticketId ? { forceNew: true } : {}) }),
      });

      if (res.ok) {
        const result = await res.json();
        // Store response ID for anonymous pre-fill on reload
        if (result.response?.id) {
          localStorage.setItem(ticketId ? `survey_${surveyId}_${ticketId}_responseId` : `survey_${surveyId}_responseId`, result.response.id);
        }
      } else {
        const error = await res.json();
        console.error('Failed to submit response:', error.error);
      }
    } catch (error) {
      console.error('Failed to submit response:', error);
    }
  };

  if (loading) {
    return (
      <div ref={containerRef} className="p-8 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-orange-500"></div>
      </div>
    );
  }

  if (!surveyData) {
    return (
      <div ref={containerRef} className="p-8 text-center">
        <p className="text-gray-600 dark:text-gray-400">Survey not found</p>
      </div>
    );
  }

  if (submitted) {
    // Editing mode: show editable survey with pre-filled data
    if (editing && surveyData) {
      return (
        <div ref={containerRef} className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-orange-500">
              <span className="text-xl">✏️</span>
              <span className="font-semibold">Editing your response</span>
            </div>
            <button
              onClick={() => setEditing(false)}
              className="text-sm text-gray-500 hover:text-gray-300 transition"
            >
              Cancel
            </button>
          </div>
          <EditableSurvey
            fields={surveyData.fields}
            answers={savedAnswers || {}}
            onSubmit={async (answers) => {
              await submitResponse(answers);
              setEditing(false);
            }}
          />
        </div>
      );
    }

    // Show completion message with option to edit
    return (
      <div ref={containerRef} className="p-6 text-center">
        <div className="text-5xl mb-3">✓</div>
        <h2 className="text-xl font-bold mb-1">Response submitted</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          Your response has been recorded.
        </p>
        <button
          onClick={() => setEditing(true)}
          className="px-4 py-2 text-sm rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 transition"
        >
          Edit answers
        </button>
      </div>
    );
  }

  if (surveyData.status !== 'published') {
    return (
      <div ref={containerRef} className="p-8 text-center">
        <p className="text-gray-600 dark:text-gray-400">
          This survey is currently {surveyData.status}.
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">{surveyData.title}</h1>
        {surveyData.description && (
          <p className="text-gray-600 dark:text-gray-400">
            {surveyData.description}
          </p>
        )}
      </div>

      {surveyModel ? (
        <Survey model={surveyModel} />
      ) : (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-orange-500"></div>
        </div>
      )}
    </div>
  );
}
