'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

interface Survey {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
}

export default function UserSurveysPage() {
  const params = useParams();
  const router = useRouter();
  const handle = params.handle as string;

  const [loading, setLoading] = useState(true);
  const [surveys, setSurveys] = useState<Survey[]>([]);

  useEffect(() => {
    fetchSurveys();
  }, [handle]);

  const fetchSurveys = async () => {
    try {
      const res = await fetch(`/api/surveys/handle/${handle}`);

      if (res.ok) {
        const data = await res.json();
        setSurveys(data.surveys || []);
      }
    } catch (error) {
      console.error('Failed to fetch surveys:', error);
    } finally {
      setLoading(false);
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
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold mb-2">@{handle}</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Published Surveys
          </p>
        </div>

        {surveys.length === 0 ? (
          <div className="text-center py-16 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="text-6xl mb-4">📊</div>
            <h2 className="text-2xl font-bold mb-2">No published surveys</h2>
            <p className="text-gray-600 dark:text-gray-400">
              This user hasn't published any surveys yet
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {surveys.map((survey) => (
              <button
                key={survey.id}
                onClick={() => router.push(`/${handle}/${survey.id}`)}
                className="w-full bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 hover:shadow-lg hover:border-orange-500 dark:hover:border-orange-500 transition text-left"
              >
                <h3 className="text-xl font-semibold mb-2">{survey.title}</h3>
                {survey.description && (
                  <p className="text-gray-600 dark:text-gray-400 mb-3">
                    {survey.description}
                  </p>
                )}
                <div className="text-sm text-gray-500">
                  Created {new Date(survey.createdAt).toLocaleDateString()}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
