import { NextRequest } from 'next/server';
import { db } from '@/db';
import { jsonResponse, errorResponse } from '@/lib/utils';

// Reserved handles that cannot be claimed
const RESERVED_HANDLES = [
  'admin', 'api', 'app', 'auth', 'blog', 'coffee', 'connect', 'dashboard',
  'docs', 'edit', 'events', 'help', 'home', 'imajin', 'inbox', 'links', 'login',
  'logout', 'mail', 'news', 'pay', 'profile', 'register', 'search', 'settings',
  'signup', 'status', 'support', 'team', 'www'
];

function isValidHandle(handle: string): boolean {
  // Lowercase, alphanumeric + hyphens, 3-30 chars
  if (!/^[a-z0-9\-]{3,30}$/.test(handle)) {
    return false;
  }

  // No leading/trailing hyphens
  if (handle.startsWith('-') || handle.endsWith('-')) {
    return false;
  }

  // No consecutive hyphens
  if (handle.includes('--')) {
    return false;
  }

  // Not reserved
  if (RESERVED_HANDLES.includes(handle)) {
    return false;
  }

  return true;
}

/**
 * GET /api/handle-check?handle=xxx
 * Check if a handle is available for registration
 */
export async function GET(request: NextRequest) {
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
      message: 'Handle must be 3-30 characters, lowercase alphanumeric + hyphens, no reserved words',
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
    console.error('Handle check failed:', error);
    return errorResponse('Failed to check handle availability', 500);
  }
}
