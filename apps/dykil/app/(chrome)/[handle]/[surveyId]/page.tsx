/* eslint-disable no-console */
'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch } from '@imajin/config';
import { useToast } from '@imajin/ui';
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

export default function SurveyResponsePage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const { handle, surveyId } = params;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [surveyData, setSurveyData] = useState<SurveyData | null>(null);
  const [surveyModel, setSurveyModel] = useState<Model | null>(null);

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

        // Create SurveyJS model — fields can be { elements: [...] } or { pages: [...] }
        // SurveyJS Model accepts both formats natively
        const surveyJson = typeof data.fields === 'object' && ('elements' in data.fields || 'pages' in data.fields)
          ? data.fields
          : { elements: Array.isArray(data.fields) ? data.fields : [] };

        const model = new Model(surveyJson);

        // Handle completion
        model.onComplete.add(async (sender) => {
          await submitResponse(sender.data);
        });

        setSurveyModel(model);
      } else {
        toast.error('Survey not found');
        router.push('/');
      }
    } catch (error) {
      console.error('Failed to fetch survey:', error);
      toast.error('Failed to load survey');
    } finally {
      setLoading(false);
    }
  };

  const submitResponse = async (data: any) => {
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/surveys/${surveyId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ answers: data }),
      });

      if (res.ok) {
        setSubmitted(true);
      } else {
        const error = await res.json();
        toast.error(error.error || 'Failed to submit response');
        setSubmitting(false);
      }
    } catch (error) {
      console.error('Failed to submit response:', error);
      toast.error('Failed to submit response');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-orange-500"></div>
      </div>
    );
  }

  if (!surveyData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Survey not found</h1>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-2xl w-full text-center">
          <div className="text-6xl mb-6">✓</div>
          <h1 className="text-3xl font-bold mb-4">Thank you!</h1>
          <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
            Your response has been recorded.
          </p>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  if (surveyData.status !== 'published') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-2xl w-full text-center">
          <h1 className="text-2xl font-bold mb-4">Survey not available</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-8">
            This survey is currently {surveyData.status}.
          </p>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-3">{surveyData.title}</h1>
            {surveyData.description && (
              <p className="text-lg text-gray-600 dark:text-gray-400">
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
      </div>
    </div>
  );
}
