import { z } from 'zod';
import { tool } from 'ai';
import { safeFetch } from './utils';

export function createMediaTools(config: {
  mediaUrl: string;
  apiKey: string;
  targetDid: string;
  requesterDid: string;
}) {
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'X-Owner-DID': config.targetDid,
  };

  return {
    searchAssets: tool({
      description: 'Search the media library for files by name. Use this to find essays, documents, images, and other uploaded files.',
      parameters: z.object({
        query: z.string().describe('Search query — filename or keyword to match'),
        type: z.string().optional().describe('Optional MIME prefix filter, e.g. "text" or "image"'),
      }),
      execute: async ({ query, type }) => {
        const url = new URL('/api/assets', config.mediaUrl);
        url.searchParams.set('search', query);
        if (type) url.searchParams.set('type', type);
        const result = await safeFetch(url.toString(), authHeaders) as any;
        if (result?.assets) {
          return result.assets.map((a: any) => ({
            id: a.id,
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
            createdAt: a.createdAt,
          }));
        }
        return result;
      },
    }),

    readAsset: tool({
      description: 'Read the text content of a file. Use this after searchAssets to retrieve essay content, documents, or configuration files.',
      parameters: z.object({
        id: z.string().describe('The asset ID from searchAssets'),
      }),
      execute: async ({ id }) => {
        return safeFetch(
          `${config.mediaUrl}/api/assets/${encodeURIComponent(id)}/content`,
          authHeaders,
        );
      },
    }),
  };
}
