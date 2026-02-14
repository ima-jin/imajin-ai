'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/button';
import { Input } from '@/components/input';
import { Select } from '@/components/select';
import { Textarea } from '@/components/textarea';

export default function DetailsPage({ params }: { params: { applianceId: string } }) {
  const router = useRouter();
  const [errorCode, setErrorCode] = useState('');
  const [details, setDetails] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const symptomCategory = typeof window !== 'undefined'
    ? sessionStorage.getItem('symptom_category') || ''
    : '';

  const handleSubmit = async () => {
    setSubmitting(true);

    try {
      const requestData = {
        applianceId: params.applianceId,
        symptomCategory,
        symptomDetails: details,
        errorCode: errorCode || null,
        mediaUrls: [],
        confidence: 'medium',
        suggestedCauses: [],
        suggestedParts: [],
      };

      const response = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData),
      });

      if (!response.ok) {
        throw new Error('Failed to submit request');
      }

      const serviceRequest = await response.json();

      sessionStorage.clear();
      router.push(`/a/${params.applianceId}/submitted?requestId=${serviceRequest.id}`);
    } catch (error) {
      console.error('Error submitting request:', error);
      alert('Failed to submit request. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          A few more details
        </h1>
        <p className="text-gray-600 mb-6">
          This helps the technician prepare
        </p>

        <div className="space-y-4 mb-6">
          <Input
            label="Error Code (if shown)"
            value={errorCode}
            onChange={(e) => setErrorCode(e.target.value)}
            placeholder="e.g., OE, F1, E2"
          />

          <Textarea
            label="Additional details"
            value={details.description || ''}
            onChange={(e) => setDetails({ ...details, description: e.target.value })}
            placeholder="Describe what's happening in your own words..."
          />

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p className="text-sm text-gray-700">
              <strong>Tip:</strong> Include details like when it started, any unusual
              sounds, or what you were doing when the problem occurred.
            </p>
          </div>
        </div>

        <Button
          fullWidth
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? 'Submitting...' : 'Request Repair'}
        </Button>
      </div>
    </div>
  );
}
