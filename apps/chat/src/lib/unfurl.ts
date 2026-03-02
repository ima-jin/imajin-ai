import { unfurl } from 'unfurl.js';

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
}

/**
 * Extracts URLs from message content and unfurls them into link previews.
 * Limits to 3 URLs per message with a 5-second timeout per URL.
 */
export async function unfurlLinks(content: string): Promise<LinkPreview[]> {
  const urls = content.match(/https?:\/\/[^\s]+/g)?.slice(0, 3) || [];

  if (urls.length === 0) {
    return [];
  }

  const previews = await Promise.allSettled(
    urls.map(url => unfurl(url, { timeout: 5000 }))
  );

  return previews
    .map((result, i) => {
      if (result.status === 'rejected') {
        return null;
      }

      const metadata = result.value;
      return {
        url: urls[i],
        title: metadata.title,
        description: metadata.description,
        image: metadata.open_graph?.images?.[0]?.url,
        favicon: metadata.favicon,
        siteName: metadata.open_graph?.site_name,
      };
    })
    .filter((preview): preview is LinkPreview => preview !== null);
}
