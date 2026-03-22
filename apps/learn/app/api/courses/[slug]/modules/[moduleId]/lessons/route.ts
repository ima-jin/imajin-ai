import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, modules, lessons } from '@/db/schema';
import { requireHardDID } from '@imajin/auth';
import { generateId, jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and, asc, sql } from 'drizzle-orm';

type RouteParams = { params: Promise<{ slug: string; moduleId: string }> };

/**
 * POST /api/courses/[slug]/modules/[moduleId]/lessons — Add lesson
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId } = await params;

  const authResult = await requireHardDID(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const courseResult = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  if (!courseResult[0]) return errorResponse('Course not found', 404);
  if (courseResult[0].creatorDid !== authResult.identity.id) return errorResponse('Not authorized', 403);

  const modResult = await db.select().from(modules)
    .where(and(eq(modules.id, moduleId), eq(modules.courseId, courseResult[0].id))).limit(1);
  if (!modResult[0]) return errorResponse('Module not found', 404);

  const body = await request.json();
  if (!body.title?.trim()) return errorResponse('Title is required');

  const maxOrder = await db.select({ max: sql<number>`coalesce(max(sort_order), -1)` })
    .from(lessons).where(eq(lessons.moduleId, moduleId));

  const lesson = {
    id: generateId('lsn'),
    moduleId,
    title: body.title.trim(),
    contentType: body.contentType || 'markdown',
    content: body.content || null,
    durationMinutes: body.durationMinutes || null,
    sortOrder: body.sortOrder ?? (Number(maxOrder[0]?.max ?? -1) + 1),
    metadata: body.metadata || {},
  };

  await db.insert(lessons).values(lesson);
  return jsonResponse(lesson, 201);
}

/**
 * GET /api/courses/[slug]/modules/[moduleId]/lessons — List lessons in module
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId } = await params;

  const courseResult = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  if (!courseResult[0]) return errorResponse('Course not found', 404);

  const result = await db.select()
    .from(lessons)
    .where(eq(lessons.moduleId, moduleId))
    .orderBy(asc(lessons.sortOrder));

  return jsonResponse({ lessons: result });
}
