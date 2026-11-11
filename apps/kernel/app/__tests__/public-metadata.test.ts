import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { APP_DISPLAY_NAME } from '@imajin/config';
import sitemap from '../sitemap';

vi.mock('../components/NavBarWithUnread', () => ({ NavBarWithUnread: () => null }));
vi.mock('@/src/components/www/bug-report-button', () => ({ BugReportButton: () => null }));
vi.mock('../providers', () => ({ Providers: () => null }));
vi.mock('@/src/lib/kernel/session', () => ({ getSessionFromCookies: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
const { getAllArticles } = vi.hoisted(() => ({ getAllArticles: vi.fn() }));
vi.mock('@/src/lib/www/articles', () => ({ getAllArticles }));

const root = resolve(__dirname, '../../../..');
const publicDir = resolve(root, 'apps/kernel/public');
const positioning = readFileSync(resolve(root, 'docs/POSITIONING.md'), 'utf8');
const oneLine = positioning.match(/\*\*One line:\*\* (.+)/)![1];
const subLine = positioning.match(/\*\*Sub-line:\*\* (.+)/)![1];
const publicPaths = ['', '/alpha', '/articles', '/how-it-works', '/compare', '/project'];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('root search and share metadata', () => {
  it.each([
    ['https://', ''],
    ['https://dev-', ' [DEV]'],
  ])('uses canonical positioning and preserves environment markers for %s', async (prefix, label) => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', prefix);
    vi.stubEnv('NEXT_PUBLIC_DOMAIN', 'imajin.ai');
    vi.resetModules();
    const { metadata, viewport } = await import('../layout');
    const title = `${APP_DISPLAY_NAME} — ${oneLine} · Alpha${label}`;
    expect(metadata.title).toEqual({ default: title, template: `%s | ${APP_DISPLAY_NAME}${label}` });
    expect(metadata.description).toBe(subLine);
    expect(metadata.openGraph).toMatchObject({
      title, description: subLine, type: 'website',
      images: [{ url: '/og-image.png', width: 1200, height: 630, alt: `Imajin · Alpha — ${oneLine}` }],
    });
    expect(metadata.twitter).toMatchObject({
      title, description: subLine, card: 'summary_large_image', images: ['/og-image.png'],
    });
    expect(metadata.robots).toEqual({ index: !label, follow: !label });
    expect(viewport).toMatchObject({ width: 'device-width', initialScale: 1 });
    expect(JSON.stringify(metadata)).not.toMatch(/runs your community|Self-hosted software for communities/);
  });
});

describe('regenerable share image', () => {
  it('prints only the canonical one line and sub-line alongside brand and alpha', async () => {
    const svg = readFileSync(resolve(publicDir, 'og-image.svg'), 'utf8');
    const textBlocks = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
      .map((match) => match[1].replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, ' ').trim());
    expect(textBlocks).toEqual(['Imajin', 'Alpha', oneLine, subLine]);
    expect(svg).toContain('font-family="Segoe UI, ui-sans-serif, system-ui, sans-serif"');
    expect(svg).toContain('fill="#0a0a0a"');
    expect(svg).toContain('fill="#f97316"');
    const png = sharp(readFileSync(resolve(publicDir, 'og-image.png')));
    expect(await png.metadata()).toMatchObject({ format: 'png', width: 1200, height: 630 });
    // Check the committed raster has branded background, orange mark and text.
    const pixel = async (left: number, top: number) => [...await png.clone()
      .extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
    expect(await pixel(0, 0)).toEqual([10, 10, 10]);
    expect(await pixel(96, 99)).toEqual([249, 115, 22]);
    const headline = await png.clone().extract({ left: 72, top: 200, width: 1056, height: 180 }).stats();
    expect(headline.channels[0].max).toBeGreaterThan(200);
  });

  it('keeps the PNG as the only root social-image mechanism', () => {
    const appDir = resolve(root, 'apps/kernel/app');
    const rootFiles = readdirSync(appDir);
    expect(rootFiles.some((name) => /^(?:opengraph|twitter)-image\./.test(name))).toBe(false);
    const generator = readFileSync(resolve(publicDir, 'render-og-image.mjs'), 'utf8');
    expect(generator).toContain("new URL('./og-image.svg', import.meta.url)");
    expect(generator).toContain("new URL('./og-image.png', import.meta.url)");
    expect(generator).toContain('sharp(source).png()');
  });
});

describe('public sitemap', () => {
  it('includes exactly the existing anonymous IA routes with no static sitemap shadow', async () => {
    getAllArticles.mockResolvedValue([]);
    const entries = await sitemap();
    expect(entries.map(({ url }) => url)).toEqual(publicPaths.map((path) => `https://imajin.ai${path}`));
    for (const path of publicPaths) {
      expect(existsSync(resolve(root, `apps/kernel/app${path}/page.tsx`))).toBe(true);
    }
    expect(existsSync(resolve(publicDir, 'sitemap.xml'))).toBe(false);
  });

  it('retains author-qualified public articles, not legacy unqualified or handleless URLs', async () => {
    getAllArticles.mockResolvedValue([
      { authorHandle: 'jin', slug: 'signed', date: '2026-11-09' },
      { authorHandle: null, slug: 'hidden', date: '2026-11-09' },
      { authorHandle: '', slug: 'missing-author', date: '2026-11-09' },
    ]);
    const urls = new Set((await sitemap()).map(({ url }) => url));
    expect(urls.has('https://imajin.ai/articles/jin/signed')).toBe(true);
    expect(urls.size).toBe(publicPaths.length + 1);
    for (const dropped of ['/register', '/articles/signed', '/articles/hidden', '/auth', '/admin']) {
      expect(urls.has(`https://imajin.ai${dropped}`)).toBe(false);
    }
  });

  it('retains all public IA routes when the database is unavailable', async () => {
    getAllArticles.mockRejectedValue(new Error('database unavailable'));
    expect((await sitemap()).map(({ url }) => url)).toEqual(publicPaths.map((path) => `https://imajin.ai${path}`));
  });
});
