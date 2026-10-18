import { z } from 'zod';
import { googleApiFetch, requireGrantAndToken } from './connector';
import { isBusinessProfileEnabled } from './features';
import { publishGoogleRead } from './read-audit';
import { requireBusinessProfileApproval } from './setup';

export const BUSINESS_PROFILE_SCOPE = 'google:business-profile:read';
const resourceId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const pageToken = z.string().min(1).max(4096).optional();
export const listLocationsSchema = z.object({
  accountId: resourceId,
  pageSize: z.number().int().min(1).max(100).default(50),
  pageToken,
}).strict();
export const listReviewsSchema = z.object({
  accountId: resourceId,
  locationId: resourceId,
  pageSize: z.number().int().min(1).max(50).default(50),
  pageToken,
  orderBy: z.enum(['rating', 'rating desc', 'updateTime desc']).optional(),
}).strict();

export interface BusinessLocation {
  name: string;
  title?: string;
  storeCode?: string;
  websiteUri?: string;
  storefrontAddress?: {
    regionCode?: string;
    languageCode?: string;
    postalCode?: string;
    administrativeArea?: string;
    locality?: string;
    addressLines?: string[];
  };
}
export interface BusinessReview {
  name?: string;
  reviewId?: string;
  reviewer?: { profilePhotoUrl?: string; displayName?: string; isAnonymous?: boolean };
  starRating?: 'STAR_RATING_UNSPECIFIED' | 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}
export interface ListLocationsResult { locations: BusinessLocation[]; nextPageToken?: string }
export interface ListReviewsResult {
  reviews: BusinessReview[];
  averageRating?: number;
  totalReviewCount?: number;
  nextPageToken?: string;
}

function requireBusinessProfileEnabled(): void {
  if (!isBusinessProfileEnabled()) {
    throw new Error('google_business_profile_disabled: operator approval is required before Business Profile reads');
  }
}

/** Business Information v1: readMask is required; explicit single-page reads. */
export async function listLocations(
  ownerDid: string,
  options: z.input<typeof listLocationsSchema>,
): Promise<ListLocationsResult> {
  requireBusinessProfileEnabled();
  await requireBusinessProfileApproval(ownerDid);
  const input = listLocationsSchema.parse(options);
  const token = await requireGrantAndToken(ownerDid, BUSINESS_PROFILE_SCOPE);
  const query = new URLSearchParams({
    readMask: 'name,title,storeCode,websiteUri,storefrontAddress',
    pageSize: String(input.pageSize),
  });
  if (input.pageToken) query.set('pageToken', input.pageToken);
  const result = await googleApiFetch<ListLocationsResult>({
    baseUrl: 'https://mybusinessbusinessinformation.googleapis.com/v1',
    path: `/accounts/${input.accountId}/locations?${query}`, token, apiLabel: 'Business Profile',
  });
  await publishGoogleRead(ownerDid, 'business-profile.locations.list');
  return { ...result, locations: result.locations ?? [] };
}

/** Reviews remain on the separate Google My Business v4 API, not Information v1. */
export async function listReviews(
  ownerDid: string,
  options: z.input<typeof listReviewsSchema>,
): Promise<ListReviewsResult> {
  requireBusinessProfileEnabled();
  await requireBusinessProfileApproval(ownerDid);
  const input = listReviewsSchema.parse(options);
  const token = await requireGrantAndToken(ownerDid, BUSINESS_PROFILE_SCOPE);
  const query = new URLSearchParams({ pageSize: String(input.pageSize) });
  if (input.pageToken) query.set('pageToken', input.pageToken);
  if (input.orderBy) query.set('orderBy', input.orderBy);
  const result = await googleApiFetch<ListReviewsResult>({
    baseUrl: 'https://mybusiness.googleapis.com/v4',
    path: `/accounts/${input.accountId}/locations/${input.locationId}/reviews?${query}`,
    token, apiLabel: 'Business Profile',
  });
  await publishGoogleRead(ownerDid, 'business-profile.reviews.list');
  return { ...result, reviews: result.reviews ?? [] };
}
