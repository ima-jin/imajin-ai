import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, enrollments, lessonProgress, lessons, modules } from '@/db/schema';
import { requireHardDID } from '@imajin/auth';
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
  const did = identity.actingAs || identity.id;

  // Get course
  const [course] = await db.select()
    .from(courses)
    .where(eq(courses.slug, slug))
    .limit(1);

  if (!course) return errorResponse('Course not found', 404);
  if (course.creatorDid !== did) return errorResponse('Not authorized', 403);

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

  // Resolve DIDs to profile names/emails
  const studentDids = enrolled.map(e => e.studentDid);
  let profileMap: Record<string, { displayName: string | null; contactEmail: string | null; handle: string | null }> = {};
  if (studentDids.length > 0) {
    try {
      const result = await db.execute(
        sql`SELECT did, display_name, contact_email, handle FROM profile.profiles WHERE did = ANY(${studentDids})`
      );
      const profiles = (result as any).rows ?? result;
      for (const p of profiles as any[]) {
        profileMap[p.did] = { displayName: p.display_name, contactEmail: p.contact_email, handle: p.handle };
      }
    } catch {
      // Profile schema may not be accessible — continue with DIDs only
    }
  }

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

    const profile = profileMap[enrollment.studentDid];

    return {
      studentDid: enrollment.studentDid,
      displayName: profile?.displayName || null,
      email: profile?.contactEmail || null,
      handle: profile?.handle || null,
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
