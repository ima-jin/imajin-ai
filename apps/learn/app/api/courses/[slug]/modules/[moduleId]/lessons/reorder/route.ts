import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, modules, lessons } from '@/db/schema';
import { requireHardDID } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and, asc } from 'drizzle-orm';

type RouteParams = { params: Promise<{ slug: string; moduleId: string }> };

/**
 * PATCH /api/courses/[slug]/modules/[moduleId]/lessons/reorder — Reorder lessons
 * Body: { order: ["lsn_abc", "lsn_def", ...] }
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId } = await params;

  const authResult = await requireHardDID(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const courseResult = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  if (!courseResult[0]) return errorResponse('Course not found', 404);
  if (courseResult[0].creatorDid !== authResult.identity.id) return errorResponse('Not authorized', 403);

  const body = await request.json();
  const { order } = body;
  if (!Array.isArray(order)) return errorResponse('order must be an array of lesson IDs');

  await Promise.all(order.map((id: string, index: number) =>
    db.update(lessons).set({ sortOrder: index }).where(eq(lessons.id, id))
  ));

  const updated = await db.select().from(lessons)
    .where(eq(lessons.moduleId, moduleId))
    .orderBy(asc(lessons.sortOrder));

  return jsonResponse({ lessons: updated });
}
