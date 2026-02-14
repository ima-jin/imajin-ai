'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/button';
import { ApplianceCard } from '@/components/appliance-card';

export default function RecognizedPage({ params }: { params: { applianceId: string } }) {
  const router = useRouter();
  const [appliance, setAppliance] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAppliance() {
      try {
        const response = await fetch(`/api/appliances/${params.applianceId}`);
        if (!response.ok) {
          throw new Error('Appliance not found');
        }
        const data = await response.json();
        setAppliance(data);
      } catch (error) {
        console.error('Error loading appliance:', error);
      } finally {
        setLoading(false);
      }
    }

    loadAppliance();
  }, [params.applianceId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!appliance) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Appliance Not Found
          </h1>
          <p className="text-gray-600">
            This appliance hasn't been registered yet. Please register it first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">
          Appliance Recognized
        </h1>

        <ApplianceCard appliance={appliance} className="mb-6" />

        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
          <p className="text-sm text-gray-600 mb-2">
            Is this still at:
          </p>
          <p className="font-medium text-gray-900">
            {appliance.address}
            {appliance.unit && ` - ${appliance.unit}`}
          </p>
        </div>

        <Button
          fullWidth
          onClick={() => router.push(`/a/${params.applianceId}/symptoms`)}
        >
          What's going wrong?
        </Button>
      </div>
    </div>
  );
}
