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

        // Create SurveyJS model
        const surveyJson = typeof data.fields === 'object' && 'elements' in data.fields || 'pages' in data.fields
          ? data.fields
          : { elements: Array.isArray(data.fields) ? data.fields : [] };

        const model = new Model(surveyJson);

        // Apply orange theme
        model.applyTheme({
          cssVariables: {
            '--sjs-primary-backcolor': '#f97316',
            '--sjs-primary-backcolor-dark': '#ea580c',
            '--sjs-primary-backcolor-light': '#fb923c',
          }
        });

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
