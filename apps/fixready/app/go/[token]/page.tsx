'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/button';

interface Partner {
  id: string;
  name: string;
  logoUrl: string | null;
}

export default function LandingPage({ params }: { params: { token: string } }) {
  const router = useRouter();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function validateToken() {
      try {
        const response = await fetch(`/api/token/${params.token}`);

        if (!response.ok) {
          throw new Error('Invalid or expired token');
        }

        const data = await response.json();
        setPartner(data.partner);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    }

    validateToken();
  }, [params.token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (error || !partner) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Invalid QR Code</h1>
          <p className="text-gray-600">
            This QR code is invalid or has expired. Please contact your service provider.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <div className="max-w-md mx-auto px-4 py-8">
        {/* Partner branding */}
        <div className="text-center mb-8">
          {partner.logoUrl && (
            <img
              src={partner.logoUrl}
              alt={partner.name}
              className="h-16 mx-auto mb-4"
            />
          )}
          <div className="text-sm text-gray-600">{partner.name}</div>
        </div>

        {/* Hero */}
        <div className="bg-white rounded-2xl shadow-lg p-8 mb-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">
            Prepare this appliance so repairs are faster when you need them
          </h1>

          <ul className="space-y-3 mb-6">
            <li className="flex items-start gap-3">
              <span className="text-blue-600 text-xl">✓</span>
              <span className="text-gray-700">Faster repair turnaround</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-blue-600 text-xl">✓</span>
              <span className="text-gray-700">Fewer repeat visits</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-blue-600 text-xl">✓</span>
              <span className="text-gray-700">Technician arrives prepared</span>
            </li>
          </ul>

          <Button
            fullWidth
            onClick={() => router.push(`/go/${params.token}/type`)}
          >
            Get Started
          </Button>

          <p className="text-xs text-gray-500 text-center mt-4">
            No account required. Takes about 2 minutes.
          </p>
        </div>
      </div>
    </div>
  );
}
