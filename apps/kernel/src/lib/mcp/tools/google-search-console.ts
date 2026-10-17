import {
  SEARCH_CONSOLE_SCOPE, listSites, listSitesSchema,
  querySearchAnalytics, searchAnalyticsSchema, inspectUrl, urlInspectionSchema,
} from '@/src/lib/google/search-console';
import { googleReaderTool } from './google-reader-tool';

export const searchConsoleTools = [
  googleReaderTool({
    name: 'google_search_console_list_sites', scope: SEARCH_CONSOLE_SCOPE,
    description: 'List Search Console properties for the selected Google connection. Requires google:search-console:read.',
    schema: listSitesSchema, read: listSites,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }),
  googleReaderTool({
    name: 'google_search_console_query_analytics', scope: SEARCH_CONSOLE_SCOPE,
    description: 'Read one bounded page of Search Console search analytics. Advance startRow explicitly for pagination. Requires google:search-console:read.',
    schema: searchAnalyticsSchema, read: querySearchAnalytics,
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: { type: 'string', maxLength: 2048, description: 'URL-prefix property or sc-domain:example.com' },
        startDate: { type: 'string', format: 'date' },
        endDate: { type: 'string', format: 'date' },
        dimensions: { type: 'array', maxItems: 7, items: { type: 'string', enum: ['country', 'device', 'page', 'query', 'searchAppearance', 'date', 'hour'] } },
        type: { type: 'string', enum: ['web', 'image', 'video', 'news', 'discover', 'googleNews'] },
        aggregationType: { type: 'string', enum: ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'] },
        dataState: { type: 'string', enum: ['final', 'all', 'hourly_all'] },
        rowLimit: { type: 'integer', minimum: 1, maximum: 25000, default: 1000 },
        startRow: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 },
      },
      required: ['siteUrl', 'startDate', 'endDate'], additionalProperties: false,
    },
  }),
  googleReaderTool({
    name: 'google_search_console_inspect_url', scope: SEARCH_CONSOLE_SCOPE,
    description: 'Inspect indexed URL status through Google Search Console (not a live URL fetch). Requires google:search-console:read.',
    schema: urlInspectionSchema, read: inspectUrl,
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: { type: 'string', maxLength: 2048 },
        inspectionUrl: { type: 'string', format: 'uri', maxLength: 2048 },
        languageCode: { type: 'string', minLength: 2, maxLength: 35 },
      },
      required: ['siteUrl', 'inspectionUrl'], additionalProperties: false,
    },
  }),
];
