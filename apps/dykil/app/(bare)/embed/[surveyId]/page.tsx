'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Model } from 'survey-core';
import { Survey } from 'survey-react-ui';
import 'survey-core/survey-core.min.css';

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

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [surveyData, setSurveyData] = useState<SurveyData | null>(null);
  const [surveyModel, setSurveyModel] = useState<Model | null>(null);
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
      const res = await fetch(`/api/surveys/${surveyId}`, {
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

        // Apply orange theme
        model.applyTheme({
          cssVariables: {
            '--sjs-primary-backcolor': '#f97316',
            '--sjs-primary-backcolor-dark': '#ea580c',
            '--sjs-primary-backcolor-light': '#fb923c',
          }
        });

        // Allow HTML in question titles/descriptions (for links etc.)
        // Only allows <a>, <b>, <i>, <em>, <strong>, <br>, <ul>, <ol>, <li>, <p>, <span>
        model.onTextMarkdown.add((_, options) => {
          // Basic allowlist sanitizer — strip everything except safe tags
          const allowed = ['a', 'b', 'i', 'em', 'strong', 'br', 'ul', 'ol', 'li', 'p', 'span'];
          const cleaned = options.text
            .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/gi, (match: string, tag: string) => {
              if (allowed.includes(tag.toLowerCase())) {
                // For <a> tags, ensure they open in new tab and have rel=noopener
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

        // Check for existing response and pre-fill
        try {
          const storedResponseId = localStorage.getItem(`survey_${surveyId}_responseId`);
          const checkUrl = new URL(`/api/surveys/${surveyId}/responses/check`, window.location.origin);
          checkUrl.searchParams.set('include', 'answers');
          if (storedResponseId) checkUrl.searchParams.set('responseId', storedResponseId);

          const checkRes = await fetch(checkUrl.toString(), { credentials: 'include' });
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            if (checkData.completed && checkData.answers) {
              model.data = checkData.answers;
              if (checkData.responseId) {
                localStorage.setItem(`survey_${surveyId}_responseId`, checkData.responseId);
              }
              // Show as already completed with pre-filled data
              setSubmitted(true);
              setSurveyData(data);
              setSurveyModel(model);
              // Notify parent that survey is already done
              window.parent.postMessage({ type: 'survey-completed', surveyId }, '*');
              return;
            }
          }
        } catch (e) {
          // Non-fatal — just proceed without pre-fill
        }

        // Handle completion
        model.onComplete.add(async (sender) => {
          await submitResponse(sender.data);
        });

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
    setSubmitting(true);
    try {
      const res = await fetch(`/api/surveys/${surveyId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ answers: data }),
      });

      if (res.ok) {
        const result = await res.json();
        // Store response ID for anonymous pre-fill on reload
        if (result.response?.id) {
          localStorage.setItem(`survey_${surveyId}_responseId`, result.response.id);
        }
        // Preserve answers on model so read-only view renders immediately
        // (SurveyJS clears display after onComplete, but we need the data for the edit UX)
        if (surveyModel) {
          surveyModel.data = data;
        }
        setSubmitted(true);
        // Notify parent iframe
        window.parent.postMessage(
          { type: 'survey-completed', surveyId },
          '*'
        );
      } else {
        const error = await res.json();
        alert(error.error || 'Failed to submit response');
        setSubmitting(false);
      }
    } catch (error) {
      console.error('Failed to submit response:', error);
      alert('Failed to submit response');
      setSubmitting(false);
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
    if (editing && surveyModel) {
      surveyModel.mode = 'edit';
      surveyModel.showCompleteButton = true;
      // Re-attach completion handler for updates
      surveyModel.onComplete.clear();
      surveyModel.onComplete.add(async (sender) => {
        await submitResponse(sender.data);
        setEditing(false);
      });
      return (
        <div ref={containerRef} className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-orange-500">
              <span className="text-xl">✏️</span>
              <span className="font-semibold">Editing your response</span>
            </div>
            <button
              onClick={() => { surveyModel.mode = 'display'; setEditing(false); }}
              className="text-sm text-gray-500 hover:text-gray-300 transition"
            >
              Cancel
            </button>
          </div>
          <Survey model={surveyModel} />
        </div>
      );
    }

    // Show pre-filled read-only survey if model has data
    if (surveyModel && Object.keys(surveyModel.data || {}).length > 0) {
      surveyModel.mode = 'display';
      return (
        <div ref={containerRef} className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
              <span className="text-xl">✓</span>
              <span className="font-semibold">Response submitted</span>
            </div>
            <button
              onClick={() => setEditing(true)}
              className="text-sm px-3 py-1 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 transition"
            >
              Edit answers
            </button>
          </div>
          <Survey model={surveyModel} />
        </div>
      );
    }
    return (
      <div ref={containerRef} className="p-8 text-center">
        <div className="text-6xl mb-4">✓</div>
        <h1 className="text-2xl font-bold mb-2">Thank you!</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Your response has been recorded.
        </p>
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

      {surveyModel && !submitting ? (
        <Survey model={surveyModel} />
      ) : (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-orange-500"></div>
        </div>
      )}
    </div>
  );
}
