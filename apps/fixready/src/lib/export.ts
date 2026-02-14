import type { ServiceRequest, Appliance, Partner } from '@/db/schema';
import type { Symptom } from './symptoms';

export interface JobSummaryData {
  request: ServiceRequest;
  appliance: Appliance;
  partner: Partner;
  symptom: Symptom | null;
}

export function formatJobSummaryEmail(data: JobSummaryData): { subject: string; body: string } {
  const { request, appliance, partner, symptom } = data;

  const subject = `New Service Request: ${appliance.type} - ${appliance.brand || 'Unknown'} ${appliance.model || ''}`;

  const partsSection = request.suggestedParts && request.suggestedParts.length > 0
    ? `\n\nSUGGESTED PARTS (bring if available)\n${request.suggestedParts.map((part) => {
        const parsed = typeof part === 'string' ? JSON.parse(part) : part;
        const prefix = parsed.confidence === 'high' ? '✓' : '○';
        return `${prefix} ${parsed.name} (${parsed.confidence} confidence)`;
      }).join('\n')}`
    : '';

  const mediaSection = request.mediaUrls && request.mediaUrls.length > 0
    ? `\n\nMEDIA\n${request.mediaUrls.map((url, i) => `- Photo ${i + 1}: ${url}`).join('\n')}`
    : '';

  const detailsSection = request.symptomDetails && typeof request.symptomDetails === 'object' && Object.keys(request.symptomDetails).length > 0
    ? `\nDetails:\n${Object.entries(request.symptomDetails).map(([key, value]) => `- ${key}: ${value}`).join('\n')}`
    : '';

  const body = `Customer: ${appliance.contactPhone || appliance.contactEmail || 'No contact info'}
Contact: ${appliance.contactPhone ? `(${appliance.contactPhone})` : appliance.contactEmail || 'N/A'}
Address: ${appliance.address}${appliance.unit ? `, ${appliance.unit}` : ''}

APPLIANCE
Type: ${appliance.type}
Brand: ${appliance.brand || 'Unknown'}
Model: ${appliance.model || 'N/A'}
Serial: ${appliance.serial || 'N/A'}
Age: ${appliance.ageRange || 'Unknown'}
Location: ${appliance.room || 'Not specified'}

ISSUE
Category: ${symptom?.label || request.symptomCategory}
${request.errorCode ? `Error Code: ${request.errorCode}` : ''}${detailsSection}${partsSection}${mediaSection}

---
Submitted via FixReady
Reference: ${request.id}
Partner: ${partner.name}`;

  return { subject, body };
}

export function formatJobSummaryWebhook(data: JobSummaryData): Record<string, unknown> {
  const { request, appliance, partner, symptom } = data;

  return {
    event: 'service_request.created',
    request_id: request.id,
    customer: {
      phone: appliance.contactPhone || null,
      email: appliance.contactEmail || null,
    },
    address: {
      full: `${appliance.address}${appliance.unit ? `, ${appliance.unit}` : ''}`,
      unit: appliance.unit || null,
      room: appliance.room || null,
    },
    appliance: {
      id: appliance.id,
      type: appliance.type,
      brand: appliance.brand || null,
      model: appliance.model || null,
      serial: appliance.serial || null,
      age_range: appliance.ageRange || null,
    },
    symptoms: {
      category: request.symptomCategory,
      label: symptom?.label || request.symptomCategory,
      error_code: request.errorCode || null,
      details: request.symptomDetails || {},
    },
    media_urls: request.mediaUrls || [],
    suggested_parts: request.suggestedParts || [],
    suggested_causes: request.suggestedCauses || [],
    confidence: request.confidence || 'medium',
    created_at: request.createdAt?.toISOString(),
  };
}

export function logJobSummary(data: JobSummaryData): void {
  const email = formatJobSummaryEmail(data);
  console.log('\n========== JOB SUMMARY EMAIL ==========');
  console.log(`Subject: ${email.subject}`);
  console.log('\n' + email.body);
  console.log('======================================\n');
}
