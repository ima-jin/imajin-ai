/**
 * GET /auth/api/services/health?service=<name>  (#2275)
 *
 * Server-side health probe for a hub-embedded service, used by
 * `<ServiceEmbed>` before it mounts the iframe. Every userspace app already
 * exposes `GET /api/health` (see e.g. apps/market/app/api/health/route.ts);
 * proxying the check through the kernel avoids relying on those apps setting
 * CORS headers for the kernel's origin just so a browser-side fetch can read
 * the response status.
 *
 * Fails OPEN (`ok: true, checked: false`) whenever the check itself can't be
 * performed — unknown env var in local dev, kernel-native service with no
 * separate origin, or `buildPublicUrl` resolving to a relative path (single-
 * node mode with no `NEXT_PUBLIC_SERVICE_PREFIX`/`NEXT_PUBLIC_DOMAIN` —
 * there's no separate origin to probe, and a relative URL isn't fetchable
 * from the server anyway) — so a missing/misconfigured health check never
 * blocks a tab that might otherwise work fine. It fails CLOSED (`ok: false`)
 * only on an explicit non-2xx response or a network-level failure talking
 * to an otherwise-configured service.
 *
 * #2425 send-back: `service` is accepted whenever it's kernel-native OR an
 * ACTIVE `registry.apps` row — not just the historical 6-app hard-coded
 * list `service-registry.ts` used to carry, which 400'd every third-party
 * app that only exists as a registry row.
 */
import { NextRequest, NextResponse } from 'next/server';
import { buildPublicUrl } from '@imajin/config';
import { isKernelNativeService } from '@/app/auth/lib/service-registry';
import { isActiveRegistryAppSlug } from '@/src/lib/kernel/app-nav';

const HEALTH_CHECK_TIMEOUT_MS = 5000;

export async function GET(request: NextRequest) {
  const service = request.nextUrl.searchParams.get('service') ?? '';
  if (!service) {
    return NextResponse.json({ error: 'unknown_service' }, { status: 400 });
  }

  if (isKernelNativeService(service)) {
    return NextResponse.json({ ok: true, checked: false });
  }

  if (!(await isActiveRegistryAppSlug(service))) {
    return NextResponse.json({ error: 'unknown_service' }, { status: 400 });
  }

  const baseUrl = buildPublicUrl(service);
  if (!/^https?:\/\//.test(baseUrl)) {
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
