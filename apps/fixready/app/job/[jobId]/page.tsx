'use client';

import { useEffect, useState } from 'react';
import { ApplianceCard } from '@/components/appliance-card';

export default function TechJobPage({ params }: { params: { jobId: string } }) {
  const [request, setRequest] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadJob() {
      try {
        // In production, this would fetch from /api/jobs/{jobId}
        // For MVP, we'll use request ID directly
        const response = await fetch(`/api/requests/${params.jobId}`);
        const data = await response.json();
        setRequest(data);
      } catch (error) {
        console.error('Error loading job:', error);
      } finally {
        setLoading(false);
      }
    }

    loadJob();
  }, [params.jobId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading job details...</div>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Job Not Found</h1>
          <p className="text-gray-600">This job doesn't exist or has been removed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-blue-600 text-white px-4 py-4">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-xl font-bold">Service Call</h1>
          <div className="text-sm opacity-90 mt-1">
            Job #{request.id.slice(-8).toUpperCase()}
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {/* Customer Contact */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="font-semibold text-gray-900 mb-3">Customer Contact</h2>
          <div className="space-y-2 text-sm">
            {request.appliance?.contactPhone && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500">📞</span>
                <a
                  href={`tel:${request.appliance.contactPhone}`}
                  className="text-blue-600 font-medium"
                >
                  {request.appliance.contactPhone}
                </a>
              </div>
            )}
            {request.appliance?.contactEmail && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500">✉️</span>
                <a
                  href={`mailto:${request.appliance.contactEmail}`}
                  className="text-blue-600"
                >
                  {request.appliance.contactEmail}
                </a>
              </div>
            )}
          </div>
        </div>

        {/* Address */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="font-semibold text-gray-900 mb-3">Location</h2>
          <div className="text-sm text-gray-700">
            <div className="font-medium">{request.appliance?.address}</div>
            {request.appliance?.unit && (
              <div className="text-gray-500">Unit: {request.appliance.unit}</div>
            )}
            {request.appliance?.room && (
              <div className="text-gray-500 mt-1">
                Room: {request.appliance.room}
              </div>
            )}
          </div>
        </div>

        {/* Appliance */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="font-semibold text-gray-900 mb-3">Appliance</h2>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-gray-500">Type:</span>{' '}
              <span className="font-medium">{request.appliance?.type}</span>
            </div>
            <div>
              <span className="text-gray-500">Brand:</span>{' '}
              <span className="font-medium">{request.appliance?.brand}</span>
            </div>
            {request.appliance?.model && (
              <div>
                <span className="text-gray-500">Model:</span>{' '}
                <span className="font-medium">{request.appliance.model}</span>
              </div>
            )}
            {request.appliance?.serial && (
              <div>
                <span className="text-gray-500">Serial:</span>{' '}
                <span className="font-mono text-xs">{request.appliance.serial}</span>
              </div>
            )}
            {request.appliance?.ageRange && (
              <div>
                <span className="text-gray-500">Age:</span>{' '}
                <span className="font-medium">{request.appliance.ageRange} years</span>
              </div>
            )}
          </div>
        </div>

        {/* Symptoms */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="font-semibold text-gray-900 mb-3">Problem Description</h2>
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-gray-500 mb-1">Issue:</div>
              <div className="font-medium text-gray-900">{request.symptomCategory}</div>
            </div>
            {request.errorCode && (
              <div>
                <div className="text-gray-500 mb-1">Error Code:</div>
                <div className="font-mono text-red-600 font-semibold">
                  {request.errorCode}
                </div>
              </div>
            )}
            {request.symptomDetails && Object.keys(request.symptomDetails).length > 0 && (
              <div>
                <div className="text-gray-500 mb-1">Additional Details:</div>
                <div className="text-gray-700">
                  {Object.entries(request.symptomDetails).map(([key, value]) => (
                    <div key={key} className="ml-2">
                      • {key}: {String(value)}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Suggested Parts */}
        {request.suggestedParts && request.suggestedParts.length > 0 && (
          <div className="bg-green-50 border-2 border-green-200 rounded-lg p-4">
            <h2 className="font-semibold text-gray-900 mb-3">
              🧰 Suggested Parts to Bring
            </h2>
            <div className="space-y-2">
              {request.suggestedParts.map((part: any, i: number) => {
                const parsed = typeof part === 'string' ? JSON.parse(part) : part;
                return (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className={`
                      w-2 h-2 rounded-full flex-shrink-0
                      ${parsed.confidence === 'high' ? 'bg-green-500' : ''}
                      ${parsed.confidence === 'medium' ? 'bg-yellow-500' : ''}
                      ${parsed.confidence === 'low' ? 'bg-gray-400' : ''}
                    `} />
                    <span className="font-medium">{parsed.name}</span>
                    <span className="text-xs text-gray-500">
                      ({parsed.confidence} confidence)
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Photos */}
        {request.mediaUrls && request.mediaUrls.length > 0 && (
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="font-semibold text-gray-900 mb-3">Customer Photos</h2>
            <div className="grid grid-cols-2 gap-3">
              {request.mediaUrls.map((url: string, i: number) => (
                <img
                  key={i}
                  src={url}
                  alt={`Photo ${i + 1}`}
                  className="w-full h-32 object-cover rounded border"
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
