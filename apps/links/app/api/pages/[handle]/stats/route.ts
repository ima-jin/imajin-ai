import { NextRequest } from 'next/server';
import { db, linkPages, links, linkClicks } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { eq, sql, desc, gte } from 'drizzle-orm';

interface RouteParams {
  params: { handle: string };
}

/**
 * GET /api/pages/:handle/stats - Get page stats (owner only)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { handle } = params;

  // Require authentication
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Fetch page
    const page = await db.query.linkPages.findFirst({
      where: (pages, { eq }) => eq(pages.handle, handle),
    });

    if (!page) {
      return errorResponse('Links page not found', 404);
    }

    // Check ownership
    if (page.did !== identity.id) {
      return errorResponse('Not authorized to view stats', 403);
    }

    // Get links with click counts
    const pageLinks = await db.query.links.findMany({
      where: (links, { eq }) => eq(links.pageId, page.id),
      orderBy: (links, { desc }) => [desc(links.clicks)],
    });

    // Calculate total clicks
    const totalClicks = pageLinks.reduce((sum, link) => sum + link.clicks, 0);

    // Get clicks by day (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const linkIds = pageLinks.map(l => l.id);
    
    let clicksByDay: { date: string; clicks: number }[] = [];
    
    if (linkIds.length > 0) {
      const dailyClicks = await db
        .select({
          date: sql<string>`date_trunc('day', ${linkClicks.clickedAt})::date`,
          clicks: sql<number>`count(*)`,
        })
        .from(linkClicks)
        .where(sql`${linkClicks.linkId} = ANY(${linkIds}) AND ${linkClicks.clickedAt} >= ${thirtyDaysAgo}`)
        .groupBy(sql`date_trunc('day', ${linkClicks.clickedAt})::date`)
        .orderBy(desc(sql`date_trunc('day', ${linkClicks.clickedAt})::date`));

      clicksByDay = dailyClicks.map(d => ({
        date: d.date,
        clicks: Number(d.clicks),
      }));
    }

    // Get top referrers
    let topReferrers: { referrer: string; clicks: number }[] = [];
    
    if (linkIds.length > 0) {
      const referrers = await db
        .select({
          referrer: linkClicks.referrer,
          clicks: sql<number>`count(*)`,
        })
        .from(linkClicks)
        .where(sql`${linkClicks.linkId} = ANY(${linkIds}) AND ${linkClicks.referrer} IS NOT NULL`)
        .groupBy(linkClicks.referrer)
        .orderBy(desc(sql`count(*)`))
        .limit(10);

      topReferrers = referrers.map(r => ({
        referrer: r.referrer || 'Direct',
        clicks: Number(r.clicks),
      }));
    }

    return jsonResponse({
      totalClicks,
      clicksByLink: pageLinks.map(l => ({
        id: l.id,
        title: l.title,
        url: l.url,
        clicks: l.clicks,
      })),
      clicksByDay,
      topReferrers,
    });
  } catch (error) {
    console.error('Failed to fetch stats:', error);
    return errorResponse('Failed to fetch stats', 500);
  }
}
