import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, enrollments, modules, lessons } from '@/db/schema';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, sql, desc } from 'drizzle-orm';

/**
 * GET /api/my/teaching — List courses I created
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const { identity } = authResult;

  const myCourses = await db.select()
    .from(courses)
    .where(eq(courses.creatorDid, identity.id))
    .orderBy(desc(courses.createdAt));

  const result = await Promise.all(myCourses.map(async (course) => {
    const enrollCount = await db.select({ count: sql<number>`count(*)` })
      .from(enrollments).where(eq(enrollments.courseId, course.id));

    const moduleCount = await db.select({ count: sql<number>`count(*)` })
      .from(modules).where(eq(modules.courseId, course.id));

    const lessonCount = await db.select({ count: sql<number>`count(*)` })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(eq(modules.courseId, course.id));

    return {
      ...course,
      enrollmentCount: Number(enrollCount[0]?.count || 0),
      moduleCount: Number(moduleCount[0]?.count || 0),
      lessonCount: Number(lessonCount[0]?.count || 0),
    };
  }));

  return jsonResponse({ courses: result });
}
