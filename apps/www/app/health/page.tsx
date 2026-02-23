'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface ServiceCheck {
  name: string;
  url: string;
  status: 'up' | 'down' | 'degraded';
  responseTime: number | null;
  statusCode: number | null;
  error?: string;
}

interface HealthResponse {
  status: 'operational' | 'degraded';
  timestamp: string;
  services: ServiceCheck[];
}

const STATUS_COLORS = {
  up: 'bg-green-500',
  down: 'bg-red-500',
  degraded: 'bg-yellow-500',
};

const STATUS_TEXT = {
  up: 'Operational',
  down: 'Down',
  degraded: 'Degraded',
};

export default function HealthPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const checkHealth = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to fetch health status');
      const data = await response.json();
      setHealth(data);
      setLastChecked(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkHealth();
    // Auto-refresh every 30 seconds
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const allUp = health?.services.every(s => s.status === 'up');

  return (
    <main className="min-h-screen py-16 px-6">
      <div className="max-w-3xl mx-auto">
        <div className="mb-12">
          <Link 
            href="/" 
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            ← Home
          </Link>
        </div>

        <div className="mb-12">
          <h1 className="text-4xl font-light tracking-tight mb-4">System Status</h1>
          
          {/* Overall status banner */}
          <div className={`rounded-lg p-6 ${
            loading ? 'bg-gray-800' :
            allUp ? 'bg-green-900/30 border border-green-800' :
            'bg-yellow-900/30 border border-yellow-800'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {loading ? (
                  <div className="w-3 h-3 rounded-full bg-gray-500 animate-pulse" />
                ) : (
                  <div className={`w-3 h-3 rounded-full ${allUp ? 'bg-green-500' : 'bg-yellow-500'}`} />
                )}
                <span className="text-xl font-medium">
                  {loading ? 'Checking...' : allUp ? 'All Systems Operational' : 'Some Systems Degraded'}
                </span>
              </div>
              <button
                onClick={checkHealth}
                disabled={loading}
                className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50"
              >
                {loading ? 'Checking...' : 'Refresh'}
              </button>
            </div>
            {lastChecked && (
              <p className="text-gray-500 text-sm mt-2">
                Last checked: {lastChecked.toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-8 p-4 bg-red-900/30 border border-red-800 rounded-lg text-red-400">
            {error}
          </div>
        )}

        {/* Services list */}
        <div className="space-y-4">
          <h2 className="text-xl font-medium text-gray-400 mb-4">Services</h2>
          
          {health?.services.map((service) => (
            <div
              key={service.name}
              className="flex items-center justify-between p-4 bg-gray-900 rounded-lg border border-gray-800"
            >
              <div className="flex items-center gap-4">
                <div className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[service.status]}`} />
                <div>
                  <a
                    href={service.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:text-orange-400 transition-colors"
                  >
                    {service.name}
                  </a>
                  <p className="text-sm text-gray-500">{service.url}</p>
                </div>
              </div>
              
              <div className="text-right">
                <p className={`font-medium ${
                  service.status === 'up' ? 'text-green-400' :
                  service.status === 'down' ? 'text-red-400' :
                  'text-yellow-400'
                }`}>
                  {STATUS_TEXT[service.status]}
                </p>
                {service.responseTime !== null && (
                  <p className="text-sm text-gray-500">
                    {service.responseTime}ms
                  </p>
                )}
                {service.error && (
                  <p className="text-sm text-red-400 max-w-48 truncate" title={service.error}>
                    {service.error}
                  </p>
                )}
              </div>
            </div>
          ))}

          {loading && !health && (
            <div className="space-y-4">
              {[...Array(7)].map((_, i) => (
                <div key={i} className="h-20 bg-gray-900 rounded-lg animate-pulse" />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-16 pt-8 border-t border-gray-800 text-center text-gray-500 text-sm">
          <p>
            Imajin services status page. Auto-refreshes every 30 seconds.
          </p>
          <p className="mt-2">
            <Link href="/register" className="text-orange-400 hover:text-orange-300">
              Get notified of updates →
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
