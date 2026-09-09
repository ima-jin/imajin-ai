/* eslint-disable no-console */
'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
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
  const allowed = new Set(['a', 'b', 'i', 'em', 'strong', 'br', 'ul', 'ol', 'li', 'p', 'span']);
  model.onTextMarkdown.add((_, options) => {
    const cleaned = options.text
      .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/gi, (match: string, tag: string) => {
        if (allowed.has(tag.toLowerCase())) {
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
function EditableSurvey({ fields, answers, onSubmit }: Readonly<{ fields: any; answers: Record<string, any>; onSubmit: (answers: Record<string, any>) => Promise<void> }>) {
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
      const data = structuredClone(sender.data);
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

/** Build the localStorage key used to remember a response id for a survey (optionally scoped to a ticket) */
function responseStorageKey(surveyId: string | string[] | undefined, ticketId: string | null): string {
  return ticketId ? `survey_${surveyId}_${ticketId}_responseId` : `survey_${surveyId}_responseId`;
}

/**
 * Sanitize raw survey field data into a null-free SurveyJS json object, filtering out
 * null elements/pages that would otherwise crash SurveyJS. Returns null when there are
 * no renderable questions.
 */
function buildSanitizedSurveyJson(fields: any) {
  let surveyJson = typeof fields === 'object' && ('elements' in fields || 'pages' in fields)
    ? fields
    : { elements: Array.isArray(fields) ? fields : [] };

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

  // Don't create a model if there are no questions
  if ((!surveyJson.elements || surveyJson.elements.length === 0) && (!surveyJson.pages || surveyJson.pages.length === 0)) {
    return null;
  }

  return surveyJson;
}

/** Create a fully configured SurveyJS model: hidden built-in completion page, dark theme, HTML allowlist */
function createConfiguredSurveyModel(surveyJson: any): Model {
  const model = new Model(surveyJson);
  // Hide SurveyJS built-in completion page — we render our own
  model.showCompletedPage = false;
  // Apply dark-mode-safe theme
  applyDarkTheme(model);
  // Allow HTML in question titles/descriptions (for links etc.)
  applyHtmlHandler(model);
  return model;
}

type CompletedResponseCheck =
  | { completed: true; answers: Record<string, any>; responseId?: string }
  | { completed: false };

/**
 * Check whether the current respondent already has a completed response for this survey,
 * pre-filling from a locally stored response id when available. When ticketId is set, only
 * checks by the ticket-scoped stored response id (not session DID). Non-fatal on any error
 * — callers should treat failures the same as "not completed".
 */
async function checkForCompletedResponse(surveyId: string | string[] | undefined, ticketId: string | null): Promise<CompletedResponseCheck> {
  try {
    const storageKey = responseStorageKey(surveyId, ticketId);
    const storedResponseId = localStorage.getItem(storageKey);

    // Ticket-scoped: no stored response means fresh form — skip the check
    if (ticketId && !storedResponseId) {
      return { completed: false };
    }

    const checkUrl = new URL(apiUrl(`/api/surveys/${surveyId}/responses/check`), globalThis.location.origin);
    checkUrl.searchParams.set('include', 'answers');
    if (storedResponseId) checkUrl.searchParams.set('responseId', storedResponseId);
    if (ticketId) checkUrl.searchParams.set('skipDid', 'true');

    const checkRes = await fetch(checkUrl.toString(), { credentials: 'include' });
    if (checkRes.ok) {
      const checkData = await checkRes.json();
      if (checkData.completed && checkData.answers) {
        return { completed: true, answers: checkData.answers, responseId: checkData.responseId };
      }
    }

    return { completed: false };
  } catch {
    // Non-fatal — just proceed without pre-fill
    return { completed: false };
  }
}

export default function SurveyEmbedPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { surveyId } = params;
  const ticketId = searchParams.get('ticketId');

  const [loading, setLoading] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [surveyData, setSurveyData] = useState<SurveyData | null>(null);
  const [surveyModel, setSurveyModel] = useState<Model | null>(null);
  const [savedAnswers, setSavedAnswers] = useState<Record<string, any> | null>(null);
  const surveyModelRef = useRef<Model | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const getParentOrigin = useCallback(() => {
    const explicitOrigin = searchParams.get('parentOrigin');
    if (explicitOrigin) return explicitOrigin;

    if (typeof document !== 'undefined' && document.referrer) {
      try {
        return new URL(document.referrer).origin;
      } catch {
        return null;
      }
    }

    return null;
  }, [searchParams]);

  // Send height updates to parent iframe
  useEffect(() => {
    const sendHeight = () => {
      if (containerRef.current && globalThis.parent) {
        const height = containerRef.current.scrollHeight;
        const targetOrigin = getParentOrigin();
        if (targetOrigin) {
          globalThis.parent.postMessage(
            { type: 'survey-height', height },
            targetOrigin
          );
        }
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
  }, [loading, submitted, surveyData, getParentOrigin]);

  useEffect(() => {
    fetchSurvey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId]);

  const fetchSurvey = async () => {
    try {
      const res = await apiFetch(`/api/surveys/${surveyId}`, {
        credentials: 'include',
      });

      if (!res.ok) {
        console.error('Survey not found');
        return;
      }

      const data = await res.json();
      setSurveyData(data);

      const surveyJson = buildSanitizedSurveyJson(data.fields);

      // Don't create a model if there are no questions
      if (!surveyJson) {
        setSurveyData(data);
        return;
      }

      const model = createConfiguredSurveyModel(surveyJson);

      // Check for existing response and pre-fill
      // When ticketId is set, only check by ticket-scoped responseId (not session DID)
      const existingResponse = await checkForCompletedResponse(surveyId, ticketId);
      if (existingResponse.completed) {
        model.data = existingResponse.answers;
        if (existingResponse.responseId) {
          localStorage.setItem(responseStorageKey(surveyId, ticketId), existingResponse.responseId);
        }
        // Show as already completed with pre-filled data
        setSavedAnswers(existingResponse.answers);
        setSubmitted(true);
        setSurveyData(data);
        surveyModelRef.current = model;
        setSurveyModel(model);
        // Notify parent that survey is already done
        const targetOrigin = getParentOrigin();
        if (targetOrigin) {
          globalThis.parent.postMessage({ type: 'survey-completed', surveyId }, targetOrigin);
        }
        return;
      }

      // Handle completion — clone data immediately since SurveyJS may mutate the reference
      model.onComplete.add(async (sender) => {
        const answers = structuredClone(sender.data);
        await submitResponse(answers);
      });

      surveyModelRef.current = model;
      setSurveyModel(model);
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

    // POST first, THEN postMessage to parent. The old order was:
    //   1) postMessage immediately, 2) POST in background
    // which raced the parent's downstream /api/register call against our own
    // INSERT into dykil.survey_responses. The events POST would frequently
    // arrive before Dykil's row was committed and 404 with 'No survey response
    // found for this ticket' — the user had to retry to make it stick.
    //
    // setSubmitted(true) above already shows the 'Response submitted' UI to the
    // user immediately; the network round-trip happens 'invisibly' behind it.
    // Only the postMessage that drives downstream state needs to wait.
    try {
      const res = await apiFetch(`/api/surveys/${surveyId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ answers: data, ...(ticketId ? { forceNew: true, ticketId } : {}) }),
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

    // Now that the response is durable in dykil.survey_responses, tell the
    // parent. The parent's onComplete → POST /api/register/[ticketId] will
    // find the row and flip the ticket to 'complete' without racing.
    const targetOrigin = getParentOrigin();
    if (targetOrigin) {
      globalThis.parent.postMessage(
        { type: 'survey-completed', surveyId, answers: data },
        targetOrigin
      );
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
            <button type="button"
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
        <button type="button"
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
