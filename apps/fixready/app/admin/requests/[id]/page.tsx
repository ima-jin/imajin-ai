'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/button';
import { ApplianceCard } from '@/components/appliance-card';

export default function RequestDetailPage({ params }: { params: { id: string } }) {
  const [request, setRequest] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadRequest() {
      try {
        const response = await fetch(`/api/requests/${params.id}`);
        const data = await response.json();
        setRequest(data);
      } catch (error) {
        console.error('Error loading request:', error);
      } finally {
        setLoading(false);
      }
    }

    loadRequest();
  }, [params.id]);

  const handleExport = () => {
    alert('Export functionality - would generate email/PDF in production');
  };

  const handleAssign = () => {
    alert('Assign functionality - would show tech assignment UI in production');
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="text-gray-500">Request not found</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-gray-900">
            Request Details
          </h1>
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleExport}>
              Export Summary
            </Button>
            <Button onClick={handleAssign}>
              Assign Tech
            </Button>
          </div>
        </div>
        <div className="text-sm text-gray-500">
          Reference: {request.id}
        </div>
      </div>

      <div className="grid gap-6">
        {/* Appliance Info */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Appliance Information
          </h2>
          {request.appliance && (
            <ApplianceCard appliance={request.appliance} />
          )}
        </div>

        {/* Symptoms */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Symptoms
          </h2>
          <div className="space-y-3">
            <div>
              <div className="text-sm text-gray-500">Category</div>
              <div className="text-base font-medium text-gray-900">
                {request.symptomCategory}
              </div>
            </div>

            {request.errorCode && (
              <div>
                <div className="text-sm text-gray-500">Error Code</div>
                <div className="text-base font-medium text-red-600">
                  {request.errorCode}
                </div>
              </div>
            )}

            {request.symptomDetails && Object.keys(request.symptomDetails).length > 0 && (
              <div>
                <div className="text-sm text-gray-500 mb-2">Additional Details</div>
                <div className="bg-gray-50 rounded p-3 text-sm text-gray-700">
                  {JSON.stringify(request.symptomDetails, null, 2)}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Suggested Parts */}
        {request.suggestedParts && request.suggestedParts.length > 0 && (
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              Suggested Parts
            </h2>
            <div className="space-y-2">
              {request.suggestedParts.map((part: any, i: number) => {
                const parsed = typeof part === 'string' ? JSON.parse(part) : part;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className={`
                      px-2 py-1 text-xs rounded
                      ${parsed.confidence === 'high' ? 'bg-green-100 text-green-800' : ''}
                      ${parsed.confidence === 'medium' ? 'bg-yellow-100 text-yellow-800' : ''}
                      ${parsed.confidence === 'low' ? 'bg-gray-100 text-gray-800' : ''}
                    `}>
                      {parsed.confidence}
                    </span>
                    <span className="text-gray-900">{parsed.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Media */}
        {request.mediaUrls && request.mediaUrls.length > 0 && (
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              Media
            </h2>
            <div className="grid grid-cols-3 gap-4">
              {request.mediaUrls.map((url: string, i: number) => (
                <img
                  key={i}
                  src={url}
                  alt={`Media ${i + 1}`}
                  className="w-full h-32 object-cover rounded"
                />
              ))}
            </div>
          </div>
        )}

        {/* Status */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Status
          </h2>
          <div className="space-y-3">
            <div>
              <div className="text-sm text-gray-500">Current Status</div>
              <div className="text-base font-medium text-gray-900">
                {request.status}
              </div>
            </div>
            {request.assignedTo && (
              <div>
                <div className="text-sm text-gray-500">Assigned To</div>
                <div className="text-base font-medium text-gray-900">
                  {request.assignedTo}
                </div>
              </div>
            )}
            <div>
              <div className="text-sm text-gray-500">Submitted</div>
              <div className="text-base font-medium text-gray-900">
                {new Date(request.createdAt).toLocaleString()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
