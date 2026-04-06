import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, modules } from '@/db/schema';
import { requireHardDID } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and } from 'drizzle-orm';

type RouteParams = { params: Promise<{ slug: string; moduleId: string }> };

async function getOwnerCourseModule(slug: string, moduleId: string, ownerDid: string): Promise<{ error: string; status: number } | { course: any; module: any }> {
  const courseResult = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  const course = courseResult[0];
  if (!course) return { error: 'Course not found', status: 404 };
  if (course.creatorDid !== ownerDid) return { error: 'Not authorized', status: 403 };

  const modResult = await db.select().from(modules)
    .where(and(eq(modules.id, moduleId), eq(modules.courseId, course.id))).limit(1);
  if (!modResult[0]) return { error: 'Module not found', status: 404 };

  return { course, module: modResult[0] };
}

/**
 * PATCH /api/courses/[slug]/modules/[moduleId] — Update module
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId } = await params;

  const authResult = await requireHardDID(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const did = authResult.identity.actingAs || authResult.identity.id;
  const result = await getOwnerCourseModule(slug, moduleId, did);
  if ('error' in result) return errorResponse(result.error, result.status);

  const body = await request.json();
  const updates: Record<string, any> = {};
  if (body.title !== undefined) updates.title = body.title.trim();
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;

  if (Object.keys(updates).length === 0) return errorResponse('No fields to update');

  await db.update(modules).set(updates).where(eq(modules.id, moduleId));

  const updated = await db.select().from(modules).where(eq(modules.id, moduleId)).limit(1);
  return jsonResponse(updated[0]);
}

/**
 * DELETE /api/courses/[slug]/modules/[moduleId] — Delete module (cascades lessons)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { slug, moduleId } = await params;

  const authResult = await requireHardDID(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const did = authResult.identity.actingAs || authResult.identity.id;
  const result = await getOwnerCourseModule(slug, moduleId, did);
  if ('error' in result) return errorResponse(result.error, result.status);

  await db.delete(modules).where(eq(modules.id, moduleId));
  return jsonResponse({ success: true });
}
