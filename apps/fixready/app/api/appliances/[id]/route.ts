import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { appliances } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const appliance = await db.query.appliances.findFirst({
      where: eq(appliances.id, params.id),
    });

    if (!appliance) {
      return NextResponse.json(
        { error: 'Appliance not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(appliance);
  } catch (error) {
    console.error('Error fetching appliance:', error);
    return NextResponse.json(
      { error: 'Failed to fetch appliance' },
      { status: 500 }
    );
  }
}
