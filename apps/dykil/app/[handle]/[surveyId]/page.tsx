'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

type FieldType = 'text' | 'textarea' | 'select' | 'rating' | 'boolean' | 'number';

interface FieldDefinition {
  id: string;
  type: FieldType;
  label: string;
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
}

interface Survey {
  id: string;
  title: string;
  description?: string;
  fields: FieldDefinition[];
  status: string;
}

export default function FillSurveyPage() {
  const params = useParams();
  const router = useRouter();
  const handle = params.handle as string;
  const surveyId = params.surveyId as string;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchSurvey();
  }, [surveyId]);

  const fetchSurvey = async () => {
    try {
      const res = await fetch(`/api/surveys/${surveyId}`);

      if (res.ok) {
        const data = await res.json();
        if (data.status !== 'published') {
          alert('This survey is not available');
          router.push(`/${handle}`);
          return;
        }
        setSurvey(data);
      } else {
        alert('Survey not found');
        router.push(`/${handle}`);
      }
    } catch (error) {
      console.error('Failed to fetch survey:', error);
      alert('Failed to load survey');
    } finally {
      setLoading(false);
    }
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    survey?.fields.forEach((field) => {
      if (field.required && !answers[field.id]) {
        newErrors[field.id] = 'This field is required';
      }

      if (field.type === 'number' && answers[field.id] !== undefined) {
        const value = Number(answers[field.id]);
        if (field.min !== undefined && value < field.min) {
          newErrors[field.id] = `Value must be at least ${field.min}`;
        }
        if (field.max !== undefined && value > field.max) {
          newErrors[field.id] = `Value must be at most ${field.max}`;
        }
      }
    });

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/surveys/${surveyId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ answers }),
      });

      if (res.ok) {
        setSubmitted(true);
      } else {
        const error = await res.json();
        alert(error.error || 'Failed to submit response');
      }
    } catch (error) {
      console.error('Failed to submit response:', error);
      alert('Failed to submit response');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  if (!survey) {
    return null;
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md mx-auto text-center">
          <div className="text-6xl mb-4">✅</div>
          <h2 className="text-3xl font-bold mb-4">Thank you!</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-8">
            Your response has been submitted successfully.
          </p>
          <button
            onClick={() => router.push(`/${handle}`)}
            className="px-6 py-3 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 transition"
          >
            View More Surveys
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-8">
          <div className="mb-8">
            <div className="text-sm text-gray-500 dark:text-gray-500 mb-2">
              Survey by @{handle}
            </div>
            <h1 className="text-3xl font-bold mb-4">{survey.title}</h1>
            {survey.description && (
              <p className="text-gray-600 dark:text-gray-400">
                {survey.description}
              </p>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {survey.fields.map((field) => (
              <div key={field.id}>
                <label className="block text-sm font-medium mb-2">
                  {field.label}
                  {field.required && <span className="text-red-500 ml-1">*</span>}
                </label>

                {field.type === 'text' && (
                  <input
                    type="text"
                    value={answers[field.id] || ''}
                    onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
                    className={`w-full px-4 py-2 border rounded-lg bg-white dark:bg-gray-900 ${
                      errors[field.id]
                        ? 'border-red-500 dark:border-red-500'
                        : 'border-gray-300 dark:border-gray-700'
                    }`}
                  />
                )}

                {field.type === 'textarea' && (
                  <textarea
                    value={answers[field.id] || ''}
                    onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
                    rows={4}
                    className={`w-full px-4 py-2 border rounded-lg bg-white dark:bg-gray-900 ${
                      errors[field.id]
                        ? 'border-red-500 dark:border-red-500'
                        : 'border-gray-300 dark:border-gray-700'
                    }`}
                  />
                )}

                {field.type === 'select' && (
                  <select
                    value={answers[field.id] || ''}
                    onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
                    className={`w-full px-4 py-2 border rounded-lg bg-white dark:bg-gray-900 ${
                      errors[field.id]
                        ? 'border-red-500 dark:border-red-500'
                        : 'border-gray-300 dark:border-gray-700'
                    }`}
                  >
                    <option value="">Select an option</option>
                    {(field.options || []).map((option, i) => (
                      <option key={i} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                )}

                {field.type === 'rating' && (
                  <div className="flex gap-2">
                    {Array.from({ length: (field.max || 5) - (field.min || 1) + 1 }, (_, i) => {
                      const value = (field.min || 1) + i;
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setAnswers({ ...answers, [field.id]: value })}
                          className={`w-12 h-12 border rounded-lg font-semibold transition ${
                            answers[field.id] === value
                              ? 'bg-orange-500 text-white border-orange-500'
                              : 'border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        >
                          {value}
                        </button>
                      );
                    })}
                  </div>
                )}

                {field.type === 'boolean' && (
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        checked={answers[field.id] === true}
                        onChange={() => setAnswers({ ...answers, [field.id]: true })}
                        className="text-orange-500"
                      />
                      <span>Yes</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        checked={answers[field.id] === false}
                        onChange={() => setAnswers({ ...answers, [field.id]: false })}
                        className="text-orange-500"
                      />
                      <span>No</span>
                    </label>
                  </div>
                )}

                {field.type === 'number' && (
                  <input
                    type="number"
                    value={answers[field.id] || ''}
                    onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value ? Number(e.target.value) : '' })}
                    min={field.min}
                    max={field.max}
                    className={`w-full px-4 py-2 border rounded-lg bg-white dark:bg-gray-900 ${
                      errors[field.id]
                        ? 'border-red-500 dark:border-red-500'
                        : 'border-gray-300 dark:border-gray-700'
                    }`}
                  />
                )}

                {errors[field.id] && (
                  <p className="mt-1 text-sm text-red-500">{errors[field.id]}</p>
                )}
              </div>
            ))}

            <button
              type="submit"
              disabled={submitting}
              className="w-full px-6 py-3 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 transition disabled:opacity-50"
            >
              {submitting ? 'Submitting...' : 'Submit Response'}
            </button>
          </form>
        </div>

        <div className="mt-8 text-center text-sm text-gray-500">
          <a href="/" className="hover:text-orange-500 transition">
            Powered by Dykil
          </a>
        </div>
      </div>
    </div>
  );
}
