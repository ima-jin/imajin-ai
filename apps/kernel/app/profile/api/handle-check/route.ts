import { NextRequest } from 'next/server';
import { db } from '@/src/db';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { isValidHandle, isReservedHandle, HANDLE_ERROR } from '@imajin/config';
import { withLogger } from '@imajin/logger';

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

  if (!isValidHandle(handle)) {
    return jsonResponse({
      available: false,
      reason: 'invalid',
      message: HANDLE_ERROR,
    });
  }

  if (isReservedHandle(handle)) {
    return jsonResponse({
      available: false,
      reason: 'reserved',
      message: 'This handle is reserved',
    });
  }

  try {
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
