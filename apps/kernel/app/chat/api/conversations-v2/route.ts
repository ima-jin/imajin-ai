// Removed as part of #435 (v1→v2 migration). All functionality is now in /api/conversations.
// This shim redirects any remaining callers.
import { NextRequest, NextResponse } from 'next/server';

function redirectToConversations(request: NextRequest): NextResponse {
  const url = new URL(request.url);
  const newUrl = new URL('/api/conversations', url.origin);
  url.searchParams.forEach((v, k) => newUrl.searchParams.set(k, v));
  return NextResponse.redirect(newUrl, 308);
}

export function GET(request: NextRequest) {
  return redirectToConversations(request);
}

export function PATCH(request: NextRequest) {
  return redirectToConversations(request);
}
