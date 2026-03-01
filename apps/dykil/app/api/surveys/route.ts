import { NextRequest } from 'next/server';
import { db, surveys } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';
import { eq } from 'drizzle-orm';

/**
 * POST /api/surveys - Create a new survey
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const body = await request.json();
    const { title, description, fields, settings, eventId, status } = body;

    if (!title) {
      return errorResponse('title is required');
    }

    if (!fields || !Array.isArray(fields) || fields.length === 0) {
      return errorResponse('fields array is required');
    }

    // Validate fields
    for (const field of fields) {
      if (!field.id || !field.type || !field.label) {
        return errorResponse('Each field must have id, type, and label');
      }
    }

    const [survey] = await db.insert(surveys).values({
      id: generateId('survey'),
      did: identity.id,
      title,
      description: description || null,
      fields,
      settings: settings || {},
      eventId: eventId || null,
      status: status || 'draft',
    }).returning();

    return jsonResponse(survey, 201);
  } catch (error) {
    console.error('Failed to create survey:', error);
    return errorResponse('Failed to create survey', 500);
  }
}

/**
 * GET /api/surveys/mine - Get current user's surveys
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const userSurveys = await db.query.surveys.findMany({
      where: (surveys, { eq }) => eq(surveys.did, identity.id),
      orderBy: (surveys, { desc }) => [desc(surveys.createdAt)],
    });

    return jsonResponse({ surveys: userSurveys });
  } catch (error) {
    console.error('Failed to fetch surveys:', error);
    return errorResponse('Failed to fetch surveys', 500);
  }
}
