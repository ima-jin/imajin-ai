import { NextRequest } from 'next/server';
import { db } from '@/src/db';
import { jsonResponse, errorResponse, isValidHandle } from '@/src/lib/kernel/utils';
import { withLogger } from '@imajin/logger';

// Reserved handles that cannot be claimed
const RESERVED_HANDLES = [
  'admin', 'api', 'app', 'auth', 'blog', 'coffee', 'connect', 'dashboard',
  'docs', 'edit', 'events', 'help', 'home', 'imajin', 'inbox', 'links', 'login',
  'logout', 'mail', 'news', 'pay', 'profile', 'register', 'search', 'settings',
  'signup', 'status', 'support', 'team', 'www'
];

/**
 * GET /api/handle-check?handle=xxx
 * Check if a handle is available for registration
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const searchParams = request.nextUrl.searchParams;
  const handle = searchParams.get('handle');

  if (!handle) {
    return errorResponse('handle parameter is required');
  }

  // Validate format first
  if (!isValidHandle(handle)) {
    return jsonResponse({
      available: false,
      reason: 'invalid',
      message: 'Handle must be 3-30 characters: lowercase letters, numbers, dots, hyphens, underscores',
    });
  }

  if (RESERVED_HANDLES.includes(handle)) {
    return jsonResponse({
      available: false,
      reason: 'reserved',
      message: 'This handle is reserved',
    });
  }

  try {
    // Check if handle is taken
    const existing = await db.query.profiles.findFirst({
      where: (profiles, { eq }) => eq(profiles.handle, handle),
    });

    if (existing) {
      return jsonResponse({
        available: false,
        reason: 'taken',
        message: 'This handle is already taken',
      });
    }

    return jsonResponse({
      available: true,
      message: 'Handle is available',
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Handle check failed');
    return errorResponse('Failed to check handle availability', 500);
  }
});
