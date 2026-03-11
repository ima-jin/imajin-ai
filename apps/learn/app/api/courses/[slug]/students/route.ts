import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, enrollments, lessonProgress, lessons, modules } from '@/db/schema';
import { requireHardDID } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and, sql, asc, count } from 'drizzle-orm';

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * GET /api/courses/[slug]/students — List enrolled students with progress (creator only)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const authResult = await requireHardDID(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }
  const { identity } = authResult;

  // Get course
  const [course] = await db.select()
    .from(courses)
    .where(eq(courses.slug, slug))
    .limit(1);

  if (!course) return errorResponse('Course not found', 404);
  if (course.creatorDid !== identity.id) return errorResponse('Not authorized', 403);

  // Count total lessons
  const courseModules = await db.select({ id: modules.id })
    .from(modules)
    .where(eq(modules.courseId, course.id));

  let totalLessons = 0;
  for (const mod of courseModules) {
    const [result] = await db.select({ count: count() })
      .from(lessons)
      .where(eq(lessons.moduleId, mod.id));
    totalLessons += result.count;
  }

  // Get enrollments with progress
  const enrolled = await db.select()
    .from(enrollments)
    .where(eq(enrollments.courseId, course.id))
    .orderBy(asc(enrollments.enrolledAt));

  const students = await Promise.all(enrolled.map(async (enrollment) => {
    // Count completed lessons
    const [progress] = await db.select({ completed: count() })
      .from(lessonProgress)
      .where(
        and(
          eq(lessonProgress.enrollmentId, enrollment.id),
          eq(lessonProgress.status, 'completed')
        )
      );

    return {
      studentDid: enrollment.studentDid,
      enrolledAt: enrollment.enrolledAt,
      completedAt: enrollment.completedAt,
      progress: {
        total: totalLessons,
        completed: progress.completed,
        percentage: totalLessons > 0 ? Math.round((progress.completed / totalLessons) * 100) : 0,
      },
    };
  }));

  return jsonResponse({
    courseTitle: course.title,
    totalStudents: students.length,
    totalLessons,
    students,
  });
}
