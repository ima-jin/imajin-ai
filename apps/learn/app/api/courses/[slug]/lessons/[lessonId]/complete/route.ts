import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, enrollments, lessonProgress, lessons, modules } from '@/db/schema';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { emitAttestation } from '@/lib/attestations';
import { eq, and, sql } from 'drizzle-orm';

type RouteParams = { params: Promise<{ slug: string; lessonId: string }> };

/**
 * POST /api/courses/[slug]/lessons/[lessonId]/complete — Mark lesson complete
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { slug, lessonId } = await params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const { identity } = authResult;

  const courseResult = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  if (!courseResult[0]) return errorResponse('Course not found', 404);

  const course = courseResult[0];

  // Verify enrollment
  const enrollResult = await db.select().from(enrollments)
    .where(and(
      eq(enrollments.courseId, course.id),
      eq(enrollments.studentDid, identity.id),
    )).limit(1);

  if (enrollResult.length === 0) {
    return errorResponse('Not enrolled in this course', 403);
  }

  const enrollment = enrollResult[0];

  // Verify lesson exists in this course
  const lessonResult = await db.select().from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(and(
      eq(lessons.id, lessonId),
      eq(modules.courseId, course.id),
    )).limit(1);

  if (lessonResult.length === 0) {
    return errorResponse('Lesson not found in this course', 404);
  }

  // Upsert progress
  const existingProgress = await db.select().from(lessonProgress)
    .where(and(
      eq(lessonProgress.enrollmentId, enrollment.id),
      eq(lessonProgress.lessonId, lessonId),
    )).limit(1);

  const now = new Date();

  if (existingProgress.length === 0) {
    await db.insert(lessonProgress).values({
      enrollmentId: enrollment.id,
      lessonId,
      status: 'completed',
      completedAt: now,
    });
  } else {
    await db.update(lessonProgress)
      .set({ status: 'completed', completedAt: now })
      .where(and(
        eq(lessonProgress.enrollmentId, enrollment.id),
        eq(lessonProgress.lessonId, lessonId),
      ));
  }

  // Check if all lessons are complete → mark course complete
  const totalLessons = await db.select({ count: sql<number>`count(*)` })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, course.id));

  const completedLessons = await db.select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(and(
      eq(lessonProgress.enrollmentId, enrollment.id),
      eq(lessonProgress.status, 'completed'),
    ));

  const total = Number(totalLessons[0]?.count || 0);
  const completed = Number(completedLessons[0]?.count || 0);

  if (completed >= total && total > 0 && !enrollment.completedAt) {
    await db.update(enrollments)
      .set({ completedAt: now })
      .where(eq(enrollments.id, enrollment.id));

    await emitAttestation({
      issuer_did: course.creatorDid,
      subject_did: identity.id,
      type: 'learn.completed',
      context_id: course.id,
      context_type: 'course',
      payload: {
        course_title: course.title,
        completed_at: now.toISOString(),
        modules_completed: total,
      },
    });
  }

  return jsonResponse({
    lessonId,
    status: 'completed',
    completedAt: now,
    courseProgress: { total, completed, percentage: total > 0 ? Math.round((completed / total) * 100) : 0 },
  });
}
