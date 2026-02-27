import { NextRequest } from 'next/server';
import { db, surveys } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq } from 'drizzle-orm';

interface RouteParams {
  params: { id: string };
}

/**
 * GET /api/surveys/:id - Get survey with fields
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = params;

  try {
    const survey = await db.query.surveys.findFirst({
      where: (surveys, { eq }) => eq(surveys.id, id),
    });

    if (!survey) {
      return errorResponse('Survey not found', 404);
    }

    // Only return published surveys to non-owners
    const authResult = await requireAuth(request);
    const isOwner = !('error' in authResult) && authResult.identity.id === survey.did;

    if (!isOwner && survey.status !== 'published') {
      return errorResponse('Survey not found', 404);
    }

    return jsonResponse(survey);
  } catch (error) {
    console.error('Failed to fetch survey:', error);
    return errorResponse('Failed to fetch survey', 500);
  }
}

/**
 * PUT /api/surveys/:id - Update survey (owner only)
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id } = params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const existing = await db.query.surveys.findFirst({
      where: (surveys, { eq }) => eq(surveys.id, id),
    });

    if (!existing) {
      return errorResponse('Survey not found', 404);
    }

    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to update this survey', 403);
    }

    const body = await request.json();
    const { title, description, fields, settings, eventId, status } = body;

    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (fields !== undefined) updates.fields = fields;
    if (settings !== undefined) updates.settings = settings;
    if (eventId !== undefined) updates.eventId = eventId;
    if (status !== undefined) updates.status = status;

    const [updated] = await db
      .update(surveys)
      .set(updates)
      .where(eq(surveys.id, id))
      .returning();

    return jsonResponse(updated);
  } catch (error) {
    console.error('Failed to update survey:', error);
    return errorResponse('Failed to update survey', 500);
  }
}

/**
 * DELETE /api/surveys/:id - Delete survey (owner only)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const existing = await db.query.surveys.findFirst({
      where: (surveys, { eq }) => eq(surveys.id, id),
    });

    if (!existing) {
      return errorResponse('Survey not found', 404);
    }

    if (existing.did !== identity.id) {
      return errorResponse('Not authorized to delete this survey', 403);
    }

    await db.delete(surveys).where(eq(surveys.id, id));

    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Failed to delete survey:', error);
    return errorResponse('Failed to delete survey', 500);
  }
}
