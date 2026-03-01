'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Survey {
  id: string;
  title: string;
  description?: string;
  status: 'draft' | 'published' | 'closed';
  createdAt: string;
  updatedAt: string;
  _responseCount?: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [surveys, setSurveys] = useState<Survey[]>([]);

  useEffect(() => {
    fetchSurveys();
  }, []);

  const fetchSurveys = async () => {
    try {
      const res = await fetch('/api/surveys/mine', {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        // Fetch response counts for each survey
        const surveysWithCounts = await Promise.all(
          data.surveys.map(async (survey: Survey) => {
            try {
              const countRes = await fetch(`/api/surveys/${survey.id}/responses`, {
                credentials: 'include',
              });
              if (countRes.ok) {
                const countData = await countRes.json();
                return { ...survey, _responseCount: countData.total || 0 };
              }
            } catch (error) {
              console.error('Failed to fetch response count:', error);
            }
            return { ...survey, _responseCount: 0 };
          })
        );
        setSurveys(surveysWithCounts);
      } else if (res.status === 401) {
        window.location.href = '/';
      }
    } catch (error) {
      console.error('Failed to fetch surveys:', error);
    } finally {
      setLoading(false);
    }
  };

  const deleteSurvey = async (id: string) => {
    if (!confirm('Are you sure you want to delete this survey? This action cannot be undone.')) {
      return;
    }

    try {
      const res = await fetch(`/api/surveys/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (res.ok) {
        await fetchSurveys();
      } else {
        const error = await res.json();
        alert(error.error || 'Failed to delete survey');
      }
    } catch (error) {
      console.error('Failed to delete survey:', error);
      alert('Failed to delete survey');
    }
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'published':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
      case 'draft':
        return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400';
      case 'closed':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400';
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">My Surveys</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              Manage your surveys and view responses
            </p>
          </div>
          <button
            onClick={() => router.push('/create')}
            className="px-6 py-3 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 transition"
          >
            Create Survey
          </button>
        </div>

        {surveys.length === 0 ? (
          <div className="text-center py-16 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="text-6xl mb-4">📊</div>
            <h2 className="text-2xl font-bold mb-2">No surveys yet</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              Create your first survey to get started
            </p>
            <button
              onClick={() => router.push('/create')}
              className="px-6 py-3 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 transition"
            >
              Create Your First Survey
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {surveys.map((survey) => (
              <div
                key={survey.id}
                className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 hover:shadow-md transition"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-xl font-semibold">{survey.title}</h3>
                      <span className={`px-3 py-1 rounded-full text-xs font-medium ${getStatusBadgeColor(survey.status)}`}>
                        {survey.status}
                      </span>
                    </div>

                    {survey.description && (
                      <p className="text-gray-600 dark:text-gray-400 mb-3 line-clamp-2">
                        {survey.description}
                      </p>
                    )}

                    <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-500">
                      <span>
                        {survey._responseCount || 0} response{survey._responseCount !== 1 ? 's' : ''}
                      </span>
                      <span>•</span>
                      <span>
                        Created {new Date(survey.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  <div className="flex gap-2 ml-4">
                    {survey.status === 'published' && (
                      <button
                        onClick={() => {
                          // Copy link to clipboard
                          const url = `${window.location.origin}/s/${survey.id}`;
                          navigator.clipboard.writeText(url);
                          alert('Survey link copied to clipboard!');
                        }}
                        className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                        title="Copy survey link"
                      >
                        Copy Link
                      </button>
                    )}

                    <button
                      onClick={() => router.push(`/create?id=${survey.id}`)}
                      className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                    >
                      Edit
                    </button>

                    <button
                      onClick={() => router.push(`/survey/${survey.id}/results`)}
                      className="px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition"
                    >
                      View Results
                    </button>

                    <button
                      onClick={() => deleteSurvey(survey.id)}
                      className="px-4 py-2 border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 rounded-lg text-sm font-medium hover:bg-red-50 dark:hover:bg-red-900/20 transition"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
