import { NextRequest, NextResponse } from 'next/server';
import { db, approvedBuilds } from '@/src/db';
import { eq, desc } from 'drizzle-orm';

/**
 * POST /api/builds/verify
 * Check if a build hash is approved
 * 
 * Request:
 * {
 *   buildHash: string,
 *   version?: string  // Optional, for additional context
 * }
 * 
 * Response:
 * {
 *   valid: boolean,
 *   source: "official" | "fork" | "unknown",
 *   version?: string,
 *   deprecated?: boolean,
 *   error?: string
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { buildHash, version } = body;

    if (!buildHash) {
      return NextResponse.json(
        { valid: false, source: 'unknown', error: 'buildHash required' },
        { status: 400 }
      );
    }

    // Look up the build hash
    const [build] = await db
      .select()
      .from(approvedBuilds)
      .where(eq(approvedBuilds.buildHash, buildHash))
      .limit(1);

    if (!build) {
      return NextResponse.json({
        valid: false,
        source: 'unknown',
        error: 'Build hash not found in approved builds',
      });
    }

    // Check if deprecated
    if (build.deprecated) {
      return NextResponse.json({
        valid: false,
        source: 'official',
        version: build.version,
        deprecated: true,
        error: 'This build version is deprecated. Please upgrade.',
      });
    }

    return NextResponse.json({
      valid: true,
      source: 'official', // TODO: Distinguish forks
      version: build.version,
      architecture: build.architecture,
      releaseDate: build.releaseDate?.toISOString(),
    });

  } catch (error) {
    console.error('Build verify error:', error);
    return NextResponse.json(
      { valid: false, source: 'unknown', error: 'Failed to verify build' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/builds/verify
 * List all approved builds
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const version = searchParams.get('version');
    const includeDeprecated = searchParams.get('deprecated') === 'true';

    let query = db
      .select({
        version: approvedBuilds.version,
        buildHash: approvedBuilds.buildHash,
        architecture: approvedBuilds.architecture,
        releaseDate: approvedBuilds.releaseDate,
        deprecated: approvedBuilds.deprecated,
      })
      .from(approvedBuilds)
      .orderBy(desc(approvedBuilds.releaseDate));

    if (version) {
      query = query.where(eq(approvedBuilds.version, version)) as any;
    }

    if (!includeDeprecated) {
      query = query.where(eq(approvedBuilds.deprecated, false)) as any;
    }

    const builds = await query.limit(100);

    return NextResponse.json({
      builds: builds.map(b => ({
        ...b,
        releaseDate: b.releaseDate?.toISOString(),
      })),
    });

  } catch (error) {
    console.error('List builds error:', error);
    return NextResponse.json(
      { error: 'Failed to list builds' },
      { status: 500 }
    );
  }
}
