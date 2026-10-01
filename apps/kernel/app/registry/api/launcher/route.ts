/**
 * GET /registry/api/launcher (#2434) — the landing grid's tile list.
 *
 * Public + unauthenticated (like `/registry/api/specs`, which it replaces for
 * the grid): static kernel/project tiles plus every registry app on the
 * `launcher` placement. See `src/lib/kernel/launcher.ts`. Per-identity
 * narrowing happens client-side via `GET /auth/api/apps?placement=launcher`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { buildLauncherEntries } from '@/src/lib/kernel/launcher';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const services = await buildLauncherEntries();
  return NextResponse.json({ services }, { headers: cors });
}
