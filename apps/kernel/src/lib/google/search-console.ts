import { z } from 'zod';
import { googleApiFetch, requireGrantAndToken } from './connector';
import { publishGoogleRead } from './read-audit';

export const SEARCH_CONSOLE_SCOPE = 'google:search-console:read';
const WEBMASTERS_API = 'https://www.googleapis.com/webmasters/v3';
const INSPECTION_API = 'https://searchconsole.googleapis.com/v1';
const httpUrl = z.string().max(2048).url().refine((value) => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'An HTTP(S) URL without credentials is required');
const siteUrl = z.union([
  httpUrl,
  z.string().max(259).regex(/^sc-domain:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i),
]);
export const listSitesSchema = z.object({}).strict();
export const searchAnalyticsSchema = z.object({
  siteUrl,
  startDate: z.string().date(),
  endDate: z.string().date(),
  dimensions: z.array(z.enum(['country', 'device', 'page', 'query', 'searchAppearance', 'date', 'hour'])).max(7).optional(),
  type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional(),
  aggregationType: z.enum(['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel']).optional(),
  dataState: z.enum(['final', 'all', 'hourly_all']).optional(),
  rowLimit: z.number().int().min(1).max(25000).default(1000),
  startRow: z.number().int().min(0).max(1000000).default(0),
}).strict().refine((value) => value.startDate <= value.endDate, 'startDate must not follow endDate');
export const urlInspectionSchema = z.object({
  siteUrl,
  inspectionUrl: httpUrl,
  languageCode: z.string().min(2).max(35).regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i).optional(),
}).strict();

export interface SearchConsoleSite {
  siteUrl: string;
  permissionLevel: 'siteOwner' | 'siteFullUser' | 'siteRestrictedUser' | 'siteUnverifiedUser';
}
export interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
export interface SearchAnalyticsResult {
  rows: SearchAnalyticsRow[];
  responseAggregationType?: string;
}
export interface UrlInspectionResult {
  inspectionResult?: {
    inspectionResultLink?: string;
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      robotsTxtState?: string;
      indexingState?: string;
      lastCrawlTime?: string;
      pageFetchState?: string;
      googleCanonical?: string;
      userCanonical?: string;
      sitemap?: string[];
      referringUrls?: string[];
      crawledAs?: string;
    };
    mobileUsabilityResult?: { verdict?: string; issues?: Array<{ issueType?: string; severity?: string; message?: string }> };
    richResultsResult?: { verdict?: string; detectedItems?: Array<{ richResultType?: string; items?: Array<{ name?: string; issues?: Array<{ issueMessage?: string; severity?: string }> }> }> };
  };
}

/** One bounded provider request per call; Search Console sites.list has no cursor. */
export async function listSites(ownerDid: string): Promise<{ sites: SearchConsoleSite[] }> {
  const token = await requireGrantAndToken(ownerDid, SEARCH_CONSOLE_SCOPE);
  const data = await googleApiFetch<{ siteEntry?: SearchConsoleSite[] }>({
    baseUrl: WEBMASTERS_API, path: '/sites', token, apiLabel: 'Search Console',
  });
  await publishGoogleRead(ownerDid, 'search-console.sites.list');
  return { sites: data.siteEntry ?? [] };
}

/** Pagination is explicit through rowLimit/startRow; never walks an unbounded feed. */
export async function querySearchAnalytics(
  ownerDid: string,
  options: z.input<typeof searchAnalyticsSchema>,
): Promise<SearchAnalyticsResult> {
  const { siteUrl: site, ...body } = searchAnalyticsSchema.parse(options);
  const token = await requireGrantAndToken(ownerDid, SEARCH_CONSOLE_SCOPE);
  const data = await googleApiFetch<SearchAnalyticsResult>({
    baseUrl: WEBMASTERS_API,
    path: `/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    method: 'POST', body, token, apiLabel: 'Search Console',
  });
  await publishGoogleRead(ownerDid, 'search-console.searchAnalytics.query');
  return { ...data, rows: data.rows ?? [] };
}

/** inspectionUrl is data sent to Google's fixed endpoint, never fetched locally. */
export async function inspectUrl(
  ownerDid: string,
  options: z.input<typeof urlInspectionSchema>,
): Promise<UrlInspectionResult> {
  const body = urlInspectionSchema.parse(options);
  const token = await requireGrantAndToken(ownerDid, SEARCH_CONSOLE_SCOPE);
  const result = await googleApiFetch<UrlInspectionResult>({
    baseUrl: INSPECTION_API, path: '/urlInspection/index:inspect',
    method: 'POST', body, token, apiLabel: 'Search Console',
  });
  await publishGoogleRead(ownerDid, 'search-console.urlInspection.inspect');
  return result;
}
