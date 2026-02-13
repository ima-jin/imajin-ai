import { NextRequest, NextResponse } from 'next/server';
import { db, submissions, submissionGroups, groups } from '@/src/db';
import { eq, sql, inArray } from 'drizzle-orm';

interface SubmitPayload {
  householdSize: number;
  postalCode?: string;
  groupIds: string[];
  spending: {
    streaming: number;
    rideshare: number;
    cloud: number;
    software: number;
    memberships: number;
    internet: number;
    utilities: number;
    rent: number;
    other: number;
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: SubmitPayload = await request.json();
    
    // Extract session info
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 
               request.headers.get('x-real-ip') ||
               null;
    
    const sessionHeaders: Record<string, string> = {};
    ['user-agent', 'accept-language', 'referer'].forEach(h => {
      const val = request.headers.get(h);
      if (val) sessionHeaders[h] = val;
    });

    // Validate
    if (!body.householdSize || body.householdSize < 1 || body.householdSize > 10) {
      return NextResponse.json({ error: 'Invalid household size' }, { status: 400 });
    }

    // Insert submission
    const [submission] = await db
      .insert(submissions)
      .values({
        householdSize: body.householdSize,
        postalCode: body.postalCode?.trim().slice(0, 20) || null,
        sessionIp: ip,
        sessionHeaders: Object.keys(sessionHeaders).length > 0 ? sessionHeaders : null,
        streaming: body.spending?.streaming || 0,
        rideshare: body.spending?.rideshare || 0,
        cloud: body.spending?.cloud || 0,
        software: body.spending?.software || 0,
        memberships: body.spending?.memberships || 0,
        internet: body.spending?.internet || 0,
        utilities: body.spending?.utilities || 0,
        rent: body.spending?.rent || 0,
        other: body.spending?.other || 0,
      })
      .returning();

    // Link to groups
    if (body.groupIds && body.groupIds.length > 0) {
      await db.insert(submissionGroups).values(
        body.groupIds.map(gid => ({
          submissionId: submission.id,
          groupId: gid,
        }))
      );
    }

    // Get summary for the groups this user joined
    let groupSummaries: Array<{
      name: string;
      householdCount: number;
      totalExtraction: number;
      breakdown: Record<string, number>;
    }> = [];

    if (body.groupIds && body.groupIds.length > 0) {
      groupSummaries = await getGroupSummaries(body.groupIds);
    }

    return NextResponse.json({
      success: true,
      submissionId: submission.id,
      groupSummaries,
    });
  } catch (error) {
    console.error('Error submitting:', error);
    return NextResponse.json({ error: 'Failed to submit' }, { status: 500 });
  }
}

async function getGroupSummaries(groupIds: string[]) {
  const results = [];
  
  for (const groupId of groupIds) {
    // Get group name
    const [group] = await db
      .select({ name: groups.name })
      .from(groups)
      .where(eq(groups.id, groupId));
    
    if (!group) continue;

    // Get aggregates for this group
    const [agg] = await db
      .select({
        count: sql<number>`count(distinct ${submissions.id})::int`,
        streaming: sql<number>`coalesce(sum(${submissions.streaming}), 0)::int`,
        rideshare: sql<number>`coalesce(sum(${submissions.rideshare}), 0)::int`,
        cloud: sql<number>`coalesce(sum(${submissions.cloud}), 0)::int`,
        software: sql<number>`coalesce(sum(${submissions.software}), 0)::int`,
        memberships: sql<number>`coalesce(sum(${submissions.memberships}), 0)::int`,
        internet: sql<number>`coalesce(sum(${submissions.internet}), 0)::int`,
        utilities: sql<number>`coalesce(sum(${submissions.utilities}), 0)::int`,
        rent: sql<number>`coalesce(sum(${submissions.rent}), 0)::int`,
        other: sql<number>`coalesce(sum(${submissions.other}), 0)::int`,
      })
      .from(submissions)
      .innerJoin(submissionGroups, eq(submissions.id, submissionGroups.submissionId))
      .where(eq(submissionGroups.groupId, groupId));

    const breakdown = {
      streaming: agg.streaming,
      rideshare: agg.rideshare,
      cloud: agg.cloud,
      software: agg.software,
      memberships: agg.memberships,
      internet: agg.internet,
      utilities: agg.utilities,
      rent: agg.rent,
      other: agg.other,
    };

    results.push({
      name: group.name,
      householdCount: agg.count,
      totalExtraction: Object.values(breakdown).reduce((a, b) => a + b, 0),
      breakdown,
    });
  }

  return results;
}
