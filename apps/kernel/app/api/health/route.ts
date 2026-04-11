import { NextResponse } from 'next/server';

interface ServiceCheck {
  name: string;
  label: string;
  url: string;
  status: 'up' | 'down' | 'degraded';
  responseTime: number | null;
  statusCode: number | null;
  error?: string;
}

import { buildPublicUrl } from '@imajin/config';

const SERVICES = [
  // Core platform
  { name: 'www', label: 'Website' },
  { name: 'auth', label: 'Auth' },
  { name: 'pay', label: 'Payments' },
  { name: 'profile', label: 'Profiles' },
  { name: 'registry', label: 'Registry' },
  { name: 'events', label: 'Events' },
  { name: 'chat', label: 'Chat' },
  { name: 'connections', label: 'Connections' },
  { name: 'input', label: 'Input' },
  { name: 'media', label: 'Media' },
  // Imajin apps
  { name: 'coffee', label: 'Coffee' },
  { name: 'dykil', label: 'Surveys' },
  { name: 'links', label: 'Links' },
  { name: 'learn', label: 'Learn' },
  { name: 'market', label: 'Market' },
];

async function checkService(service: { name: string; label: string }): Promise<ServiceCheck> {
  const url = buildPublicUrl(service.name);
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'manual', // Don't follow redirects — a redirect means the service is alive
      cache: 'no-store',
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - start;

    // Any response (including redirects, 401, 403) means the service is up.
    // Only 5xx means degraded.
    const status = response.status >= 500 ? 'degraded' : 'up';

    return {
      name: service.name,
      label: service.label,
      url,
      status,
      responseTime,
      statusCode: response.status,
    };
  } catch (error) {
    const responseTime = Date.now() - start;
    return {
      name: service.name,
      label: service.label,
      url,
      status: 'down',
      responseTime: responseTime < 10000 ? responseTime : null,
      statusCode: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function GET() {
  const checks = await Promise.all(SERVICES.map(checkService));

  const allUp = checks.every(c => c.status === 'up');
  const anyDown = checks.some(c => c.status === 'down');

  return NextResponse.json({
    status: anyDown ? 'degraded' : allUp ? 'operational' : 'degraded',
    version: process.env.NEXT_PUBLIC_VERSION || '0.0.0',
    build: process.env.NEXT_PUBLIC_BUILD_HASH || 'dev',
    timestamp: new Date().toISOString(),
    services: checks,
  });
}
