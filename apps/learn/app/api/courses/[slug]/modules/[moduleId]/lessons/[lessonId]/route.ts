import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, modules, lessons, enrollments } from '@/db/schema';
import { requireHardDID, getSessionFromCookie } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and } from 'drizzle-orm';

type RouteParams = { params: Promise<{ slug: string; moduleId: string; lessonId: string }> };

/**
 * GET /api/courses/[slug]/modules/[moduleId]/lessons/[lessonId] — Get lesson content
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId, lessonId } = await params;

  const courseResult = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  if (!courseResult[0]) return errorResponse('Course not found', 404);

  const course = courseResult[0];

  const lessonResult = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lessonResult[0]) return errorResponse('Lesson not found', 404);

  const lesson = lessonResult[0];

  // For paid courses, check enrollment
  if (course.price && course.price > 0) {
    const cookieHeader = request.headers.get('Cookie');
    const identity = await getSessionFromCookie(cookieHeader);

    // Creator always has access
    if (identity?.id !== course.creatorDid) {
      if (!identity) return errorResponse('Authentication required for paid courses', 401);

      const enrolled = await db.select().from(enrollments)
        .where(and(
          eq(enrollments.courseId, course.id),
          eq(enrollments.studentDid, identity.id),
        )).limit(1);

      if (enrolled.length === 0) {
        // Return lesson metadata but not content
        return jsonResponse({
          id: lesson.id,
          title: lesson.title,
          contentType: lesson.contentType,
          durationMinutes: lesson.durationMinutes,
          sortOrder: lesson.sortOrder,
          content: null,
          locked: true,
        });
      }
    }
  }

  return jsonResponse(lesson);
}

/**
 * PATCH /api/courses/[slug]/modules/[moduleId]/lessons/[lessonId] — Update lesson
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId, lessonId } = await params;

  const authResult = await requireHardDID(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const courseResult = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  if (!courseResult[0]) return errorResponse('Course not found', 404);
  if (courseResult[0].creatorDid !== authResult.identity.id) return errorResponse('Not authorized', 403);

  const body = await request.json();
  const updates: Record<string, any> = {};
  const allowed = ['title', 'contentType', 'content', 'durationMinutes', 'sortOrder', 'metadata'];

  for (const field of allowed) {
    if (body[field] !== undefined) updates[field] = body[field];
  }

  if (Object.keys(updates).length === 0) return errorResponse('No fields to update');
  updates.updatedAt = new Date();

  await db.update(lessons).set(updates).where(eq(lessons.id, lessonId));

  const updated = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  return jsonResponse(updated[0]);
}

/**
 * DELETE /api/courses/[slug]/modules/[moduleId]/lessons/[lessonId] — Delete lesson
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId, lessonId } = await params;

  const authResult = await requireHardDID(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const courseResult = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  if (!courseResult[0]) return errorResponse('Course not found', 404);
  if (courseResult[0].creatorDid !== authResult.identity.id) return errorResponse('Not authorized', 403);

  await db.delete(lessons).where(eq(lessons.id, lessonId));
  return jsonResponse({ success: true });
}
