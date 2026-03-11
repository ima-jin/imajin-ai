import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, modules, lessons, enrollments, lessonProgress } from '@/db/schema';
import { requireAuth, requireHardDID, getSessionFromCookie } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and, sql, asc } from 'drizzle-orm';

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * GET /api/courses/[slug] — Get course detail
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const result = await db.select()
    .from(courses)
    .where(eq(courses.slug, slug))
    .limit(1);

  if (result.length === 0) {
    return errorResponse('Course not found', 404);
  }

  const course = result[0];

  // Single session lookup for visibility, creator check, and enrollment
  const cookieHeader = request.headers.get('Cookie');
  const identity = await getSessionFromCookie(cookieHeader);
  const isCreator = identity?.id === course.creatorDid;

  // Check visibility
  if (course.visibility === 'private') {
    if (!isCreator) {
      return errorResponse('Course not found', 404);
    }
  }

  // TODO: trust-bound visibility check via connections service

  // Get modules with lessons
  const courseModules = await db.select()
    .from(modules)
    .where(eq(modules.courseId, course.id))
    .orderBy(asc(modules.sortOrder));

  const modulesWithLessons = await Promise.all(courseModules.map(async (mod) => {
    const moduleLessons = await db.select({
      id: lessons.id,
      title: lessons.title,
      contentType: lessons.contentType,
      content: lessons.content,
      durationMinutes: lessons.durationMinutes,
      sortOrder: lessons.sortOrder,
      metadata: lessons.metadata,
    })
      .from(lessons)
      .where(eq(lessons.moduleId, mod.id))
      .orderBy(asc(lessons.sortOrder));

    // Strip content + metadata for non-creators (keep listing lean)
    const sanitized = isCreator
      ? moduleLessons
      : moduleLessons.map(({ content, metadata, ...rest }) => rest);

    return { ...mod, lessons: sanitized };
  }));

  // Check enrollment for current user
  let enrollment = null;
  if (identity) {
    const enrollResult = await db.select()
      .from(enrollments)
      .where(and(
        eq(enrollments.courseId, course.id),
        eq(enrollments.studentDid, identity.id),
      ))
      .limit(1);

    if (enrollResult.length > 0) {
      // Get progress
      const progress = await db.select()
        .from(lessonProgress)
        .where(eq(lessonProgress.enrollmentId, enrollResult[0].id));

      const totalLessons = modulesWithLessons.reduce((sum, m) => sum + m.lessons.length, 0);
      const completedLessons = progress.filter(p => p.status === 'completed').length;

      enrollment = {
        ...enrollResult[0],
        progress: { total: totalLessons, completed: completedLessons },
      };
    }
  }

  return jsonResponse({
    ...course,
    modules: modulesWithLessons,
    enrollment,
    isCreator,
    isAuthenticated: !!identity,
  });
}

/**
 * PATCH /api/courses/[slug] — Update course (owner only)
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const authResult = await requireHardDID(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  const result = await db.select()
    .from(courses)
    .where(eq(courses.slug, slug))
    .limit(1);

  if (result.length === 0) {
    return errorResponse('Course not found', 404);
  }

  const course = result[0];
  if (course.creatorDid !== identity.id) {
    return errorResponse('Not authorized', 403);
  }

  const body = await request.json();
  const allowedFields = ['title', 'description', 'slug', 'price', 'currency', 'visibility', 'imageUrl', 'tags', 'metadata', 'status', 'eventSlug', 'courseType'];
  const updates: Record<string, any> = {};

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse('No fields to update');
  }

  // Map camelCase to snake_case
  if (updates.imageUrl !== undefined) {
    updates.image_url = updates.imageUrl;
    delete updates.imageUrl;
  }
  if (updates.eventSlug !== undefined) {
    updates.event_slug = updates.eventSlug;
    delete updates.eventSlug;
  }
  if (updates.courseType !== undefined) {
    updates.course_type = updates.courseType;
    delete updates.courseType;
  }

  updates.updated_at = new Date();

  await db.update(courses)
    .set(updates)
    .where(eq(courses.id, course.id));

  const updated = await db.select()
    .from(courses)
    .where(eq(courses.id, course.id))
    .limit(1);

  return jsonResponse(updated[0]);
}

/**
 * DELETE /api/courses/[slug] — Archive course (soft delete, owner only)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const authResult = await requireHardDID(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  const result = await db.select()
    .from(courses)
    .where(eq(courses.slug, slug))
    .limit(1);

  if (result.length === 0) {
    return errorResponse('Course not found', 404);
  }

  if (result[0].creatorDid !== identity.id) {
    return errorResponse('Not authorized', 403);
  }

  await db.update(courses)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(courses.id, result[0].id));

  return jsonResponse({ success: true });
}
