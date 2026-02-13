import { NextRequest, NextResponse } from 'next/server';
import { db, groups, submissionGroups } from '@/src/db';
import { eq, sql } from 'drizzle-orm';

// GET /api/groups - List all groups with member counts
export async function GET() {
  try {
    const result = await db
      .select({
        id: groups.id,
        name: groups.name,
        memberCount: sql<number>`count(${submissionGroups.submissionId})::int`,
      })
      .from(groups)
      .leftJoin(submissionGroups, eq(groups.id, submissionGroups.groupId))
      .groupBy(groups.id, groups.name)
      .orderBy(sql`count(${submissionGroups.submissionId}) desc`);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching groups:', error);
    return NextResponse.json({ error: 'Failed to fetch groups' }, { status: 500 });
  }
}

// POST /api/groups - Create a new group
export async function POST(request: NextRequest) {
  try {
    const { name } = await request.json();
    
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Group name required' }, { status: 400 });
    }

    const cleanName = name.trim().slice(0, 100);
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 
               request.headers.get('x-real-ip') ||
               'unknown';

    // Check if exists
    const existing = await db
      .select()
      .from(groups)
      .where(eq(groups.name, cleanName))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json(existing[0]);
    }

    // Create new
    const [newGroup] = await db
      .insert(groups)
      .values({ name: cleanName, createdByIp: ip })
      .returning();

    return NextResponse.json(newGroup, { status: 201 });
  } catch (error) {
    console.error('Error creating group:', error);
    return NextResponse.json({ error: 'Failed to create group' }, { status: 500 });
  }
}
