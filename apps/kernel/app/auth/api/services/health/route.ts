/**
 * GET /auth/api/services/health?service=<name>  (#2275)
 *
 * Server-side health probe for a hub-embedded service, used by
 * `<ServiceEmbed>` before it mounts the iframe. Every userspace app already
 * exposes `GET /api/health` (see e.g. apps/coffee/app/api/health/route.ts);
 * proxying the check through the kernel avoids relying on those apps setting
 * CORS headers for the kernel's origin just so a browser-side fetch can read
 * the response status.
 *
 * Fails OPEN (`ok: true, checked: false`) whenever the check itself can't be
 * performed — unknown env var in local dev, kernel-native service with no
 * separate origin — so a missing/misconfigured health check never blocks a
 * tab that might otherwise work fine. It fails CLOSED (`ok: false`) only on
 * an explicit non-2xx response or a network-level failure talking to an
 * otherwise-configured service.
 */
import { NextRequest, NextResponse } from 'next/server';
import { KNOWN_SERVICES, getServiceBaseUrl, isKernelNativeService } from '@/app/auth/lib/service-registry';

const HEALTH_CHECK_TIMEOUT_MS = 5000;

export async function GET(request: NextRequest) {
  const service = request.nextUrl.searchParams.get('service') ?? '';
  if (!KNOWN_SERVICES.has(service)) {
    return NextResponse.json({ error: 'unknown_service' }, { status: 400 });
  }

  if (isKernelNativeService(service)) {
    return NextResponse.json({ ok: true, checked: false });
  }

  const baseUrl = getServiceBaseUrl(service);
  if (!baseUrl) {
    return NextResponse.json({ ok: true, checked: false });
  }

  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return NextResponse.json({ ok: res.ok, checked: true, status: res.status });
  } catch {
    return NextResponse.json({ ok: false, checked: true, status: 0 });
  }
}
