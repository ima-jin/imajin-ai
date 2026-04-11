import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
const log = createLogger('dykil');
import { db, surveys } from '@/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';
import { eq } from 'drizzle-orm';

interface RouteParams {
  params: { id: string };
}

/**
 * OPTIONS /api/surveys/:id - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/surveys/:id - Get survey with fields
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const cors = corsHeaders(request);
  const { id } = params;

  try {
    const survey = await db.query.surveys.findFirst({
      where: (surveys, { eq }) => eq(surveys.id, id),
    });

    if (!survey) {
      return errorResponse('Survey not found', 404, cors);
    }

    // Only return published surveys to non-owners
    const authResult = await requireAuth(request);
    const isOwner = !('error' in authResult) && authResult.identity.id === survey.did;

    if (!isOwner && survey.status !== 'published') {
      return errorResponse('Survey not found', 404, cors);
    }

    return jsonResponse(survey, 200, cors);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch survey');
    return errorResponse('Failed to fetch survey', 500, cors);
  }
}

/**
 * PUT /api/surveys/:id - Update survey (owner only)
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const cors = corsHeaders(request);
  const { id } = params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;

  try {
    const existing = await db.query.surveys.findFirst({
      where: (surveys, { eq }) => eq(surveys.id, id),
    });

    if (!existing) {
      return errorResponse('Survey not found', 404, cors);
    }

    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to update this survey', 403, cors);
    }

    const body = await request.json();
    const { title, description, fields, settings, type, status } = body;

    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (fields !== undefined) updates.fields = fields;
    if (settings !== undefined) updates.settings = settings;
    if (type !== undefined) updates.type = type;
    if (status !== undefined) updates.status = status;
    const [updated] = await db
      .update(surveys)
      .set(updates)
      .where(eq(surveys.id, id))
      .returning();

    return jsonResponse(updated, 200, cors);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update survey');
    return errorResponse('Failed to update survey', 500, cors);
  }
}

/**
 * DELETE /api/surveys/:id - Delete survey (owner only)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const cors = corsHeaders(request);
  const { id } = params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;

  try {
    const existing = await db.query.surveys.findFirst({
      where: (surveys, { eq }) => eq(surveys.id, id),
    });

    if (!existing) {
      return errorResponse('Survey not found', 404, cors);
    }

    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to delete this survey', 403, cors);
    }

    await db.delete(surveys).where(eq(surveys.id, id));

    return jsonResponse({ deleted: true }, 200, cors);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to delete survey');
    return errorResponse('Failed to delete survey', 500, cors);
  }
}
