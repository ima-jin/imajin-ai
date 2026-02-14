import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { serviceRequests } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const serviceRequest = await db.query.serviceRequests.findFirst({
      where: eq(serviceRequests.id, params.id),
      with: {
        appliance: true,
      },
    });

    if (!serviceRequest) {
      return NextResponse.json(
        { error: 'Service request not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(serviceRequest);
  } catch (error) {
    console.error('Error fetching service request:', error);
    return NextResponse.json(
      { error: 'Failed to fetch service request' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();

    const [updated] = await db
      .update(serviceRequests)
      .set({
        ...body,
        updatedAt: new Date(),
      })
      .where(eq(serviceRequests.id, params.id))
      .returning();

    if (!updated) {
      return NextResponse.json(
        { error: 'Service request not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Error updating service request:', error);
    return NextResponse.json(
      { error: 'Failed to update service request' },
      { status: 500 }
    );
  }
}
