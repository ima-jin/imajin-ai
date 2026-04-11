import { NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { buildPublicUrl } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';

const sql = getClient();

interface ServiceHealth {
  name: string;
  label: string;
  group: 'kernel' | 'userspace';
  status: 'healthy' | 'degraded' | 'down';
  responseTime: number | null;
  version?: string;
  build?: string;
  checkedAt: string;
}

const KERNEL_SERVICES = [
  { name: 'auth', label: 'Auth', path: '/auth/api/health' },
  { name: 'pay', label: 'Pay', path: '/pay/api/health' },
  { name: 'profile', label: 'Profile', path: '/profile/api/health' },
  { name: 'connections', label: 'Connections', path: '/connections/api/health' },
  { name: 'chat', label: 'Chat', path: '/chat/api/health' },
  { name: 'media', label: 'Media', path: '/media/api/health' },
  { name: 'notify', label: 'Notify', path: '/notify/api/health' },
  { name: 'registry', label: 'Registry', path: '/registry/api/health' },
  { name: 'www', label: 'WWW', path: '/api/health' },
];

const USERSPACE_SERVICES = [
  { name: 'events', label: 'Events' },
  { name: 'market', label: 'Market' },
  { name: 'coffee', label: 'Coffee' },
  { name: 'learn', label: 'Learn' },
  { name: 'links', label: 'Links' },
  { name: 'dykil', label: 'Surveys' },
];

interface CacheEntry {
  data: { services: ServiceHealth[]; checkedAt: string };
  expiresAt: number;
}
let cache: CacheEntry | null = null;

async function checkKernelService(
  svc: (typeof KERNEL_SERVICES)[number]
): Promise<ServiceHealth> {
  const port = process.env.PORT ?? '7000';
  const url = `http://localhost:${port}${svc.path}`;
  const checkedAt = new Date().toISOString();
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeout);
    const responseTime = Date.now() - start;

    let version: string | undefined;
    let build: string | undefined;
    try {
      const data = await res.json();
      version = data.version;
      build = data.build;
    } catch {
      // ignore parse errors
    }

    const status = !res.ok ? 'down' : responseTime > 2000 ? 'degraded' : 'healthy';
    return { name: svc.name, label: svc.label, group: 'kernel', status, responseTime, version, build, checkedAt };
  } catch {
    const responseTime = Date.now() - start;
    return {
      name: svc.name,
      label: svc.label,
      group: 'kernel',
      status: 'down',
      responseTime: responseTime < 3000 ? responseTime : null,
      checkedAt,
    };
  }
}

async function checkUserspaceService(
  svc: (typeof USERSPACE_SERVICES)[number]
): Promise<ServiceHealth> {
  const envKey = `${svc.name.toUpperCase()}_URL`;
  const url = (process.env[envKey] ?? buildPublicUrl(svc.name)) + '/api/health';
  const checkedAt = new Date().toISOString();
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeout);
    const responseTime = Date.now() - start;

    let version: string | undefined;
    let build: string | undefined;
    try {
      const data = await res.json();
      version = data.version;
      build = data.build;
    } catch {
      // ignore parse errors
    }

    const status = !res.ok ? 'down' : responseTime > 2000 ? 'degraded' : 'healthy';
    return { name: svc.name, label: svc.label, group: 'userspace', status, responseTime, version, build, checkedAt };
  } catch {
    const responseTime = Date.now() - start;
    return {
      name: svc.name,
      label: svc.label,
      group: 'userspace',
      status: 'down',
      responseTime: responseTime < 3000 ? responseTime : null,
      checkedAt,
    };
  }
}

export const GET = withLogger('kernel', async (_req, { log }) => {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Return cached result if fresh
  if (cache && cache.expiresAt > Date.now()) {
    return NextResponse.json(cache.data);
  }

  const [kernelResults, userspaceResults] = await Promise.all([
    Promise.all(KERNEL_SERVICES.map(checkKernelService)),
    Promise.all(USERSPACE_SERVICES.map(checkUserspaceService)),
  ]);

  const services = [...kernelResults, ...userspaceResults];
  const checkedAt = new Date().toISOString();
  const result = { services, checkedAt };

  cache = { data: result, expiresAt: Date.now() + 30_000 };

  log.info({ serviceCount: services.length }, 'admin services health check complete');

  return NextResponse.json(result);
});
