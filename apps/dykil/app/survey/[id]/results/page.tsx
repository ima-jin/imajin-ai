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
  createdAt: string;
}

interface Response {
  id: string;
  answers: Record<string, any>;
  respondentDid?: string;
  createdAt: string;
}

interface Aggregation {
  [fieldId: string]: {
    field: FieldDefinition;
    values: Record<string, number>;
    textResponses?: string[];
    average?: number;
    total: number;
  };
}

export default function ResultsPage() {
  const params = useParams();
  const router = useRouter();
  const surveyId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [responses, setResponses] = useState<Response[]>([]);
  const [aggregation, setAggregation] = useState<Aggregation>({});

  useEffect(() => {
    fetchData();
  }, [surveyId]);

  const fetchData = async () => {
    try {
      const [surveyRes, responsesRes] = await Promise.all([
        fetch(`/api/surveys/${surveyId}`, { credentials: 'include' }),
        fetch(`/api/surveys/${surveyId}/responses`, { credentials: 'include' }),
      ]);

      if (surveyRes.ok && responsesRes.ok) {
        const surveyData = await surveyRes.json();
        const responsesData = await responsesRes.json();

        setSurvey(surveyData);
        setResponses(responsesData.responses || []);

        // Aggregate responses
        const agg = aggregateResponses(surveyData.fields, responsesData.responses || []);
        setAggregation(agg);
      } else {
        alert('Failed to load survey results');
        router.push('/dashboard');
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
      alert('Failed to load results');
    } finally {
      setLoading(false);
    }
  };

  const aggregateResponses = (fields: FieldDefinition[], responses: Response[]): Aggregation => {
    const agg: Aggregation = {};

    fields.forEach((field) => {
      agg[field.id] = {
        field,
        values: {},
        textResponses: [],
        total: 0,
      };

      responses.forEach((response) => {
        const answer = response.answers[field.id];

        if (answer !== undefined && answer !== null && answer !== '') {
          agg[field.id].total++;

          if (field.type === 'text' || field.type === 'textarea') {
            agg[field.id].textResponses?.push(String(answer));
          } else if (field.type === 'select' || field.type === 'boolean') {
            const key = String(answer);
            agg[field.id].values[key] = (agg[field.id].values[key] || 0) + 1;
          } else if (field.type === 'rating' || field.type === 'number') {
            const value = Number(answer);
            const key = String(value);
            agg[field.id].values[key] = (agg[field.id].values[key] || 0) + 1;
          }
        }
      });

      // Calculate average for rating and number fields
      if (field.type === 'rating' || field.type === 'number') {
        const values = Object.entries(agg[field.id].values).map(([key, count]) =>
          Number(key) * count
        );
        const sum = values.reduce((a, b) => a + b, 0);
        agg[field.id].average = agg[field.id].total > 0 ? sum / agg[field.id].total : 0;
      }
    });

    return agg;
  };

  const exportToCSV = () => {
    if (!survey || responses.length === 0) return;

    const headers = ['Response ID', 'Submitted At', ...survey.fields.map(f => f.label)];
    const rows = responses.map(response => {
      return [
        response.id,
        new Date(response.createdAt).toLocaleString(),
        ...survey.fields.map(field => {
          const answer = response.answers[field.id];
          if (answer === undefined || answer === null) return '';
          return String(answer);
        }),
      ];
    });

    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${survey.title.replace(/[^a-z0-9]/gi, '_')}_results.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">{survey.title}</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              {responses.length} response{responses.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={exportToCSV}
              disabled={responses.length === 0}
              className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              onClick={() => router.push('/dashboard')}
              className="px-4 py-2 bg-orange-500 text-white rounded-lg font-medium hover:bg-orange-600 transition"
            >
              Back to Dashboard
            </button>
          </div>
        </div>

        {responses.length === 0 ? (
          <div className="text-center py-16 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="text-6xl mb-4">📭</div>
            <h2 className="text-2xl font-bold mb-2">No responses yet</h2>
            <p className="text-gray-600 dark:text-gray-400">
              Share your survey to start collecting responses
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {survey.fields.map((field) => {
              const agg = aggregation[field.id];
              if (!agg) return null;

              return (
                <div
                  key={field.id}
                  className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6"
                >
                  <h3 className="text-xl font-semibold mb-4">{field.label}</h3>
                  <div className="text-sm text-gray-500 dark:text-gray-500 mb-4">
                    {agg.total} response{agg.total !== 1 ? 's' : ''}
                  </div>

                  {(field.type === 'select' || field.type === 'boolean' || field.type === 'rating' || field.type === 'number') && (
                    <div>
                      {field.type === 'boolean' && (
                        <div className="space-y-3">
                          {['true', 'false'].map((key) => {
                            const count = agg.values[key] || 0;
                            const percentage = agg.total > 0 ? (count / agg.total) * 100 : 0;
                            return (
                              <div key={key}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="font-medium">{key === 'true' ? 'Yes' : 'No'}</span>
                                  <span className="text-sm text-gray-500">
                                    {count} ({percentage.toFixed(1)}%)
                                  </span>
                                </div>
                                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
                                  <div
                                    className="bg-orange-500 h-3 rounded-full transition-all"
                                    style={{ width: `${percentage}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {field.type === 'select' && (
                        <div className="space-y-3">
                          {Object.entries(agg.values)
                            .sort(([, a], [, b]) => b - a)
                            .map(([key, count]) => {
                              const percentage = agg.total > 0 ? (count / agg.total) * 100 : 0;
                              return (
                                <div key={key}>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="font-medium">{key}</span>
                                    <span className="text-sm text-gray-500">
                                      {count} ({percentage.toFixed(1)}%)
                                    </span>
                                  </div>
                                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
                                    <div
                                      className="bg-orange-500 h-3 rounded-full transition-all"
                                      style={{ width: `${percentage}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      )}

                      {(field.type === 'rating' || field.type === 'number') && (
                        <div>
                          <div className="mb-4 p-4 bg-orange-50 dark:bg-orange-900/20 rounded-lg">
                            <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">
                              Average
                            </div>
                            <div className="text-3xl font-bold text-orange-500">
                              {agg.average?.toFixed(2)}
                            </div>
                          </div>
                          <div className="space-y-3">
                            {Object.entries(agg.values)
                              .sort(([a], [b]) => Number(a) - Number(b))
                              .map(([key, count]) => {
                                const percentage = agg.total > 0 ? (count / agg.total) * 100 : 0;
                                return (
                                  <div key={key}>
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="font-medium">{key}</span>
                                      <span className="text-sm text-gray-500">
                                        {count} ({percentage.toFixed(1)}%)
                                      </span>
                                    </div>
                                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
                                      <div
                                        className="bg-orange-500 h-3 rounded-full transition-all"
                                        style={{ width: `${percentage}%` }}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {(field.type === 'text' || field.type === 'textarea') && (
                    <div className="space-y-3">
                      {(agg.textResponses || []).length === 0 ? (
                        <div className="text-gray-500 text-sm">No responses</div>
                      ) : (
                        (agg.textResponses || []).map((response, i) => (
                          <div
                            key={i}
                            className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
                          >
                            <p className="text-sm whitespace-pre-wrap">{response}</p>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {responses.length > 0 && (
          <div className="mt-8 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
            <h2 className="text-xl font-semibold mb-4">Individual Responses</h2>
            <div className="space-y-4">
              {responses.map((response, index) => (
                <details
                  key={response.id}
                  className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
                >
                  <summary className="cursor-pointer font-medium">
                    Response #{responses.length - index} - {new Date(response.createdAt).toLocaleString()}
                  </summary>
                  <div className="mt-4 space-y-3 pl-4">
                    {survey.fields.map((field) => {
                      const answer = response.answers[field.id];
                      return (
                        <div key={field.id}>
                          <div className="text-sm font-medium text-gray-600 dark:text-gray-400">
                            {field.label}
                          </div>
                          <div className="mt-1">
                            {answer === undefined || answer === null || answer === '' ? (
                              <span className="text-gray-400 text-sm italic">No answer</span>
                            ) : field.type === 'boolean' ? (
                              <span>{answer ? 'Yes' : 'No'}</span>
                            ) : (
                              <span>{String(answer)}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
