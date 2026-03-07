import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, enrollments, lessonProgress } from '@/db/schema';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, sql } from 'drizzle-orm';

/**
 * GET /api/my/courses — List courses I'm enrolled in
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const { identity } = authResult;

  const myEnrollments = await db.select()
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(enrollments.studentDid, identity.id));

  const result = await Promise.all(myEnrollments.map(async (row) => {
    const progress = await db.select({
      total: sql<number>`count(*)`,
      completed: sql<number>`count(*) filter (where status = 'completed')`,
    }).from(lessonProgress).where(eq(lessonProgress.enrollmentId, row.enrollments.id));

    const total = Number(progress[0]?.total || 0);
    const completed = Number(progress[0]?.completed || 0);

    return {
      ...row.courses,
      enrollment: {
        id: row.enrollments.id,
        enrolledAt: row.enrollments.enrolledAt,
        completedAt: row.enrollments.completedAt,
      },
      progress: {
        total,
        completed,
        percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
      },
    };
  }));

  return jsonResponse({ courses: result });
}
