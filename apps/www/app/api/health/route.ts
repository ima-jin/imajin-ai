import { NextResponse } from 'next/server';

interface ServiceCheck {
  name: string;
  url: string;
  status: 'up' | 'down' | 'degraded';
  responseTime: number | null;
  statusCode: number | null;
  error?: string;
}

const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

const SERVICES = [
  { name: 'www', url: `${SERVICE_PREFIX}www.${DOMAIN}` },
  { name: 'auth', url: `${SERVICE_PREFIX}auth.${DOMAIN}` },
  { name: 'pay', url: `${SERVICE_PREFIX}pay.${DOMAIN}` },
  { name: 'profile', url: `${SERVICE_PREFIX}profile.${DOMAIN}` },
  { name: 'registry', url: `${SERVICE_PREFIX}registry.${DOMAIN}` },
  { name: 'events', url: `${SERVICE_PREFIX}events.${DOMAIN}` },
  { name: 'chat', url: `${SERVICE_PREFIX}chat.${DOMAIN}` },
];

async function checkService(service: { name: string; url: string }): Promise<ServiceCheck> {
  const start = Date.now();
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
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
