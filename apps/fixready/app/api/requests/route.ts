import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { serviceRequests, appliances, partners, type NewServiceRequest } from '@/db/schema';
import { generateId } from '@/lib/utils';
import { getSymptomById } from '@/lib/symptoms';
import { logJobSummary } from '@/lib/export';
import { eq } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const newRequest: NewServiceRequest = {
      id: generateId('req'),
      applianceId: body.applianceId,
      symptomCategory: body.symptomCategory,
      symptomDetails: body.symptomDetails || {},
      errorCode: body.errorCode || null,
      mediaUrls: body.mediaUrls || [],
      confidence: body.confidence || 'medium',
      suggestedCauses: body.suggestedCauses || [],
      suggestedParts: body.suggestedParts || [],
      status: 'new',
      assignedTo: null,
      notes: null,
    };

    const [serviceRequest] = await db.insert(serviceRequests).values(newRequest).returning();

    // Fetch related data for job summary
    const appliance = await db.query.appliances.findFirst({
      where: eq(appliances.id, body.applianceId),
    });

    if (appliance) {
      const partner = await db.query.partners.findFirst({
        where: eq(partners.id, appliance.partnerId),
      });

      if (partner) {
        const symptom = getSymptomById(appliance.type, body.symptomCategory);

        // Log job summary (in MVP, we just log - could send email here)
        logJobSummary({
          request: serviceRequest,
          appliance,
          partner,
          symptom,
        });
      }
    }

    return NextResponse.json(serviceRequest, { status: 201 });
  } catch (error) {
    console.error('Error creating service request:', error);
    return NextResponse.json(
      { error: 'Failed to create service request' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const applianceId = searchParams.get('applianceId');

    const results = await db.query.serviceRequests.findMany({
      with: {
        appliance: true,
      },
      orderBy: (requests, { desc }) => [desc(requests.createdAt)],
    });

    return NextResponse.json(results);
  } catch (error) {
    console.error('Error fetching service requests:', error);
    return NextResponse.json(
      { error: 'Failed to fetch service requests' },
      { status: 500 }
    );
  }
}
