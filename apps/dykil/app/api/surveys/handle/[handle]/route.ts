import { NextRequest } from 'next/server';
import { db, surveys } from '@/db';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq } from 'drizzle-orm';

interface RouteParams {
  params: { handle: string };
}

/**
 * GET /api/surveys/handle/:handle - Get published surveys by user handle
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { handle } = params;

  try {
    // First, we need to resolve the handle to a DID
    // This would typically query a profiles/users table
    // For now, we'll need to query surveys and get unique DIDs
    // In a real implementation, you'd query a users table first

    // Note: This is a simplified implementation
    // In production, you should have a profiles service or table
    // that maps handles to DIDs

    const allSurveys = await db.query.surveys.findMany({
      where: (surveys, { eq }) => eq(surveys.status, 'published'),
      orderBy: (surveys, { desc }) => [desc(surveys.createdAt)],
    });

    // For now, we'll return an empty array
    // The proper implementation requires a user/profile lookup
    return jsonResponse({ surveys: [], handle });
  } catch (error) {
    console.error('Failed to fetch surveys by handle:', error);
    return errorResponse('Failed to fetch surveys', 500);
  }
}
