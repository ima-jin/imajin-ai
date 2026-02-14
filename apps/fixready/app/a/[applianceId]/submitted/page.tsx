'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/button';

export default function SubmittedPage({ params }: { params: { applianceId: string } }) {
  const searchParams = useSearchParams();
  const requestId = searchParams.get('requestId');
  const [partner, setPartner] = useState<any>(null);

  useEffect(() => {
    async function loadPartner() {
      try {
        const applianceRes = await fetch(`/api/appliances/${params.applianceId}`);
        const appliance = await applianceRes.json();

        // In production, fetch partner from API
        setPartner({
          name: 'Your Service Provider',
          responseWindowCopy: "We'll contact you within 24 hours",
        });
      } catch (error) {
        console.error('Error loading partner:', error);
      }
    }

    loadPartner();
  }, [params.applianceId]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-green-50 to-white">
      <div className="max-w-md mx-auto px-4 py-8">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-green-100 rounded-full mb-4">
            <span className="text-4xl">✓</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Request Sent
          </h1>
          <p className="text-gray-600">
            Your service provider has what they need to prepare.
          </p>
        </div>

        <div className="bg-white rounded-lg border-2 border-gray-200 p-6 mb-6">
          <div className="mb-4">
            <div className="text-sm text-gray-500 mb-1">Reference ID</div>
            <div className="font-mono text-lg font-semibold text-gray-900">
              {requestId}
            </div>
          </div>

          <div className="border-t pt-4">
            <div className="text-sm text-gray-600">
              {partner?.responseWindowCopy || "They'll contact you shortly."}
            </div>
          </div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <p className="text-sm text-gray-700">
            The technician will review your appliance details and symptoms before
            arriving, so they can bring the right parts and tools.
          </p>
        </div>

        <Button
          fullWidth
          variant="outline"
          onClick={() => window.location.href = '/'}
        >
          Done
        </Button>
      </div>
    </div>
  );
}
