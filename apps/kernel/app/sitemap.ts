import { MetadataRoute } from 'next';
import { getAllArticles } from '@/src/lib/www/articles';

const DOMAIN = 'https://imajin.ai';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const articles = await getAllArticles();

  const articleUrls = articles
    .filter((article) => article.authorHandle)
    .map((article) => ({
      url: `${DOMAIN}/articles/${article.authorHandle}/${article.slug}`,
      lastModified: new Date(article.date),
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    }));

  return [
    {
      url: DOMAIN,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: `${DOMAIN}/articles`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    ...articleUrls,
  ];
}
