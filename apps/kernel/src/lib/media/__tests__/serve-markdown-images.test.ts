import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import type { Asset } from '@/src/db';
import { serveMarkdown } from '../serve-asset';

/**
 * End-to-end check of the article reader path (#1532): plain markdown images
 * pointing at a media asset come out the other side as responsive
 * `<img srcset sizes>`, and everything else is left alone.
 */

const ASSET = '/media/api/assets/asset_Ifznk1POwuTd88_G';

function makeAsset(): Asset {
  return {
    id: 'asset_article',
    mimeType: 'text/markdown',
    hash: 'deadbeef',
    filename: 'essay-42.md',
    ownerDid: 'did:imajin:test',
    storagePath: '/tmp/essay-42.md',
  } as unknown as Asset;
}

async function render(markdown: string): Promise<string> {
  const request = new NextRequest('https://imajin.ai/media/api/assets/asset_article', {
    headers: { accept: 'text/html' },
  });
  const response = await serveMarkdown(
    request,
    makeAsset(),
    Buffer.from(markdown, 'utf-8'),
    'public',
    {},
  );
  expect(response).not.toBeNull();
  return response!.text();
}

const FRONTMATTER = ['---', 'title: "Git Never Modeled the Agent"', 'slug: "essay-42"', '---', ''].join('\n');

describe('serveMarkdown — responsive article images', () => {
  it('upgrades a plain markdown asset image to srcset + sizes', async () => {
    const html = await render(`${FRONTMATTER}\n![A diagram](${ASSET})\n`);

    expect(html).toContain(`src="${ASSET}?w=800"`);
    expect(html).toContain(`${ASSET}?w=400 400w`);
    expect(html).toContain(`${ASSET}?w=1600 1600w`);
    expect(html).toContain('sizes="(max-width: 680px) 100vw, 680px"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('style="max-width:100%;height:auto;"');
    expect(html).toContain('alt="A diagram"');
  });

  it('leaves an external markdown image untouched', async () => {
    const html = await render(`${FRONTMATTER}\n![Ext](https://example.com/photo.jpg)\n`);

    expect(html).toContain('<img src="https://example.com/photo.jpg" alt="Ext">');
    expect(html).not.toContain('srcset');
  });

  it('keeps hand-authored figure markup rendering, and upgrades its asset image', async () => {
    const html = await render(
      `${FRONTMATTER}\n<figure>\n  <img src="${ASSET}?width=1600" alt="Essay figure" style="max-width:600px">\n  <figcaption>The commit graph</figcaption>\n</figure>\n`,
    );

    expect(html).toContain('<figure>');
    expect(html).toContain('<figcaption>The commit graph</figcaption>');
    expect(html).toContain('style="max-width:600px"');
    expect(html).toContain(`${ASSET}?w=1200 1200w`);
  });

  it('still renders the article shell and its 680px column', async () => {
    const html = await render(`${FRONTMATTER}\nJust prose, no images.\n`);

    expect(html).toContain('<title>Git Never Modeled the Agent</title>');
    expect(html).toContain('max-width: 680px');
    expect(html).toContain('Just prose, no images.');
  });
});
