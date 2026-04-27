'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ImajinFooter } from '@imajin/ui';

interface ServiceCheck {
  name: string;
  label?: string;
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

const STATUS_COLORS: Record<string, string> = {
  up: 'bg-success',
  down: 'bg-error',
  degraded: 'bg-warning',
};

const STATUS_TEXT: Record<string, string> = {
  up: 'Operational',
  down: 'Down',
  degraded: 'Degraded',
};

function ServiceRow({ service }: { service: ServiceCheck }) {
  return (
    <div className="flex items-center justify-between p-4 bg-surface-surface border border-white/10">
      <div className="flex items-center gap-4">
        <div className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[service.status]}`} />
        <div>
          <a
            href={service.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium hover:text-imajin-orange transition-colors"
          >
            {service.label || service.name}
          </a>
          <p className="text-sm text-secondary">{service.name}.imajin.ai</p>
        </div>
      </div>
      <div className="text-right">
        <p className={`font-medium ${
          service.status === 'up' ? 'text-success' :
          service.status === 'down' ? 'text-error' :
          'text-warning'
        }`}>
          {STATUS_TEXT[service.status]}
        </p>
        {service.responseTime !== null && (
          <p className="text-sm text-secondary">{service.responseTime}ms</p>
        )}
        {service.error && (
          <p className="text-sm text-error max-w-48 truncate" title={service.error}>{service.error}</p>
        )}
      </div>
    </div>
  );
}

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

  const CORE_NAMES = ['www', 'auth', 'pay', 'profile', 'registry', 'events', 'chat', 'connections', 'input', 'media'];
  const coreServices = health?.services.filter(s => CORE_NAMES.includes(s.name)) || [];
  const appServices = health?.services.filter(s => !CORE_NAMES.includes(s.name)) || [];

  return (
    <main className="min-h-screen py-16 px-6">
      <div className="max-w-3xl mx-auto">
        <div className="mb-12">
          <Link
            href="/"
            className="text-secondary hover:text-primary transition-colors"
          >
            ← Home
          </Link>
        </div>

        <div className="mb-12">
          <h1 className="text-4xl font-light tracking-tight mb-4 font-mono">System Status</h1>

          {/* Overall status banner */}
          <div className={`p-6 ${
            loading ? 'bg-surface-elevated' :
            allUp ? 'bg-success/30 border border-green-800' :
            'bg-warning/20 border border-yellow-800'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {loading ? (
                  <div className="w-3 h-3 rounded-full bg-gray-500 animate-pulse" />
                ) : (
                  <div className={`w-3 h-3 rounded-full ${allUp ? 'bg-success' : 'bg-warning'}`} />
                )}
                <span className="text-xl font-medium">
                  {loading ? 'Checking...' : allUp ? 'All Systems Operational' : 'Some Systems Degraded'}
                </span>
              </div>
              <button
                onClick={checkHealth}
                disabled={loading}
                className="px-4 py-2 text-sm bg-surface-elevated hover:bg-gray-600 transition-colors disabled:opacity-50"
              >
                {loading ? 'Checking...' : 'Refresh'}
              </button>
            </div>
            {lastChecked && (
              <p className="text-secondary text-sm mt-2">
                Last checked: {lastChecked.toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-8 p-4 bg-error/30 border border-red-800 text-error">
            {error}
          </div>
        )}

        {/* Services list */}
        <div className="space-y-3">
          <h2 className="text-xl font-medium text-secondary mb-4 font-mono">Core Platform</h2>
          {coreServices.map(s => <ServiceRow key={s.name} service={s} />)}
        </div>

        {appServices.length > 0 && (
          <div className="space-y-3 mt-8">
            <h2 className="text-xl font-medium text-secondary mb-4 font-mono">Applications</h2>
            {appServices.map(s => <ServiceRow key={s.name} service={s} />)}
          </div>
        )}

        {loading && !health && (
          <div className="space-y-3">
            {[...Array(14)].map((_, i) => (
              <div key={i} className="h-20 bg-surface-surface animate-pulse" />
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="mt-16 pt-8 border-t border-white/10 text-center text-secondary text-sm">
          <p>
            Imajin services status page. Auto-refreshes every 30 seconds.
          </p>
        </div>
        <div className="mt-8">
          <ImajinFooter />
        </div>
      </div>
    </main>
  );
}
