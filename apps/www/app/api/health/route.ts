import { NextResponse } from 'next/server';

interface ServiceCheck {
  name: string;
  url: string;
  status: 'up' | 'down' | 'degraded';
  responseTime: number | null;
  statusCode: number | null;
  error?: string;
}

const SERVICES = [
  { name: 'www', url: 'https://www.imajin.ai' },
  { name: 'auth', url: 'https://auth.imajin.ai' },
  { name: 'pay', url: 'https://pay.imajin.ai' },
  { name: 'profile', url: 'https://profile.imajin.ai' },
  { name: 'registry', url: 'https://registry.imajin.ai' },
  { name: 'events', url: 'https://events.imajin.ai' },
  { name: 'chat', url: 'https://chat.imajin.ai' },
];

async function checkService(service: { name: string; url: string }): Promise<ServiceCheck> {
  const start = Date.now();
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const response = await fetch(service.url, {
      method: 'HEAD',
      signal: controller.signal,
      cache: 'no-store',
    });
    
    clearTimeout(timeout);
    const responseTime = Date.now() - start;
    
    return {
      name: service.name,
      url: service.url,
      status: response.ok ? 'up' : 'degraded',
      responseTime,
      statusCode: response.status,
    };
  } catch (error) {
    const responseTime = Date.now() - start;
    return {
      name: service.name,
      url: service.url,
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
    timestamp: new Date().toISOString(),
    services: checks,
  });
}
