'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/button';
import { ApplianceCard } from '@/components/appliance-card';

export default function DonePage({ params }: { params: { token: string } }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const applianceId = searchParams.get('applianceId');
  const [appliance, setAppliance] = useState<any>(null);

  useEffect(() => {
    if (applianceId) {
      fetch(`/api/appliances/${applianceId}`)
        .then(res => res.json())
        .then(setAppliance)
        .catch(console.error);
    }
  }, [applianceId]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-green-50 to-white">
      <div className="max-w-md mx-auto px-4 py-8">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-green-100 rounded-full mb-4">
            <span className="text-4xl">✓</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Appliance Registered
          </h1>
        </div>

        {appliance && (
          <ApplianceCard appliance={appliance} className="mb-6" />
        )}

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <p className="text-sm text-gray-700">
            <strong>Important:</strong> Leave the magnet on the appliance.
            Scan again if something goes wrong to report the issue.
          </p>
        </div>

        <div className="space-y-3">
          <Button
            fullWidth
            variant="secondary"
            onClick={() => router.push(`/go/${params.token}/type`)}
          >
            Register Another Appliance
          </Button>

          <Button
            fullWidth
            variant="outline"
            onClick={() => router.push('/')}
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
