import {
  BUSINESS_PROFILE_SCOPE, listLocations, listLocationsSchema, listReviews, listReviewsSchema,
} from '@/src/lib/google/business-profile';
import { googleReaderTool } from './google-reader-tool';

const accountId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' };
const pageToken = { type: 'string', minLength: 1, maxLength: 4096 };
export const businessProfileTools = [
  googleReaderTool({
    name: 'google_business_profile_list_locations', scope: BUSINESS_PROFILE_SCOPE,
    description: 'Read one page of Business Profile locations for a bare accountId. Operator approval and google:business-profile:read are required.',
    schema: listLocationsSchema, read: listLocations,
    inputSchema: {
      type: 'object',
      properties: { accountId, pageToken, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      required: ['accountId'], additionalProperties: false,
    },
  }),
  googleReaderTool({
    name: 'google_business_profile_list_reviews', scope: BUSINESS_PROFILE_SCOPE,
    description: 'Read one page of Business Profile reviews for bare accountId/locationId. Operator approval and google:business-profile:read are required.',
    schema: listReviewsSchema, read: listReviews,
    inputSchema: {
      type: 'object',
      properties: {
        accountId, locationId: accountId, pageToken,
        pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
        orderBy: { type: 'string', enum: ['rating', 'rating desc', 'updateTime desc'] },
      },
      required: ['accountId', 'locationId'], additionalProperties: false,
    },
  }),
];
