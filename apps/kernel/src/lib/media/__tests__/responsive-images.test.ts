import { describe, it, expect } from 'vitest';
import {
  rewriteResponsiveImages,
  parseMediaAssetUrl,
  buildSrcset,
  buildVariantUrl,
  RESPONSIVE_WIDTHS,
  RESPONSIVE_SIZES,
  FALLBACK_WIDTH,
} from '../responsive-images';

const ASSET = '/media/api/assets/asset_Ifznk1POwuTd88_G';

/** Pull a single attribute value out of a rewritten tag. */
function attr(html: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(html);
  return m ? m[1] : null;
}

describe('parseMediaAssetUrl', () => {
  it('recognises root-relative asset URLs', () => {
    expect(parseMediaAssetUrl(ASSET)).toEqual({ base: ASSET, query: '', hash: '' });
  });

  it('recognises absolute asset URLs', () => {
    const url = `https://imajin.ai${ASSET}`;
    expect(parseMediaAssetUrl(url)?.base).toBe(url);
  });

  it('strips any pre-existing width param (w or width)', () => {
    expect(parseMediaAssetUrl(`${ASSET}?width=1600`)?.query).toBe('');
    expect(parseMediaAssetUrl(`${ASSET}?w=1600`)?.query).toBe('');
  });

  it('preserves unrelated query params and the fragment', () => {
    const parts = parseMediaAssetUrl(`${ASSET}?v=2&w=900#fig1`);
    expect(parts?.query).toBe('v=2');
    expect(parts?.hash).toBe('#fig1');
  });

  it('rejects non-asset URLs', () => {
    expect(parseMediaAssetUrl('https://example.com/photo.jpg')).toBeNull();
    expect(parseMediaAssetUrl('/images/logo.svg')).toBeNull();
    expect(parseMediaAssetUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(parseMediaAssetUrl('')).toBeNull();
  });

  it('rejects asset sub-resources that are not the image itself', () => {
    expect(parseMediaAssetUrl(`${ASSET}/fair`)).toBeNull();
    expect(parseMediaAssetUrl(`${ASSET}/versions`)).toBeNull();
  });

  it('rejects URLs containing srcset separators (space or comma)', () => {
    expect(parseMediaAssetUrl('/media/api/assets/a,b')).toBeNull();
    expect(parseMediaAssetUrl('/media/api/assets/a b')).toBeNull();
  });
});

describe('buildVariantUrl / buildSrcset', () => {
  it('appends the resize param the endpoint actually honours (w, not width)', () => {
    const parts = parseMediaAssetUrl(ASSET)!;
    expect(buildVariantUrl(parts, 400)).toBe(`${ASSET}?w=400`);
  });

  it('joins surviving params with & and keeps the fragment last', () => {
    const parts = parseMediaAssetUrl(`${ASSET}?v=2#fig1`)!;
    expect(buildVariantUrl(parts, 800)).toBe(`${ASSET}?v=2&w=800#fig1`);
  });

  it('emits one candidate per ladder width', () => {
    const srcset = buildSrcset(parseMediaAssetUrl(ASSET)!);
    expect(srcset.split(', ')).toHaveLength(RESPONSIVE_WIDTHS.length);
    for (const w of RESPONSIVE_WIDTHS) {
      expect(srcset).toContain(`${ASSET}?w=${w} ${w}w`);
    }
  });
});

describe('rewriteResponsiveImages — markdown-authored asset images', () => {
  const input = `<p><img src="${ASSET}" alt="A diagram"></p>`;

  it('emits src at the fallback width', () => {
    expect(attr(rewriteResponsiveImages(input), 'src')).toBe(`${ASSET}?w=${FALLBACK_WIDTH}`);
  });

  it('emits the full srcset ladder', () => {
    const srcset = attr(rewriteResponsiveImages(input), 'srcset');
    expect(srcset).toBe(RESPONSIVE_WIDTHS.map((w) => `${ASSET}?w=${w} ${w}w`).join(', '));
  });

  it('emits sizes keyed to the 680px article column', () => {
    expect(attr(rewriteResponsiveImages(input), 'sizes')).toBe(RESPONSIVE_SIZES);
    expect(RESPONSIVE_SIZES).toBe('(max-width: 680px) 100vw, 680px');
  });

  it('emits loading=lazy and decoding=async', () => {
    const out = rewriteResponsiveImages(input);
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('decoding="async"');
  });

  it('emits a fluid inline style', () => {
    expect(attr(rewriteResponsiveImages(input), 'style')).toBe('max-width:100%;height:auto;');
  });

  it('preserves the alt text', () => {
    expect(attr(rewriteResponsiveImages(input), 'alt')).toBe('A diagram');
  });

  it('keeps the surrounding markup intact', () => {
    const out = rewriteResponsiveImages(input);
    expect(out.startsWith('<p>')).toBe(true);
    expect(out.endsWith('</p>')).toBe(true);
  });

  it('rewrites every image in a multi-image body', () => {
    const out = rewriteResponsiveImages(
      `<img src="/media/api/assets/asset_one"><img src="/media/api/assets/asset_two">`,
    );
    expect(out).toContain('/media/api/assets/asset_one?w=400 400w');
    expect(out).toContain('/media/api/assets/asset_two?w=400 400w');
  });
});

describe('rewriteResponsiveImages — images that must be left alone', () => {
  it('leaves external images untouched', () => {
    const html = '<p><img src="https://example.com/photo.jpg" alt="ext"></p>';
    expect(rewriteResponsiveImages(html)).toBe(html);
  });

  it('leaves local non-asset images untouched', () => {
    const html = '<img src="/images/logo.svg" alt="logo">';
    expect(rewriteResponsiveImages(html)).toBe(html);
  });

  it('leaves an author-supplied srcset untouched', () => {
    const html = `<img src="${ASSET}" srcset="${ASSET}?w=2000 2000w" sizes="50vw">`;
    expect(rewriteResponsiveImages(html)).toBe(html);
  });

  it('leaves an img with no src untouched', () => {
    const html = '<img alt="broken">';
    expect(rewriteResponsiveImages(html)).toBe(html);
  });

  it('returns non-image HTML byte-for-byte', () => {
    const html = '<h2>Heading</h2>\n<p>Body with <a href="/x">a link</a>.</p>';
    expect(rewriteResponsiveImages(html)).toBe(html);
  });
});

describe('rewriteResponsiveImages — hand-authored HTML stays working', () => {
  it('upgrades a hand-authored figure image while keeping its own style and caption', () => {
    const html = `<figure><img src="${ASSET}?width=1600" alt="Essay figure" style="max-width:600px;border-radius:8px"><figcaption>Caption</figcaption></figure>`;
    const out = rewriteResponsiveImages(html);

    expect(out).toContain('<figure>');
    expect(out).toContain('<figcaption>Caption</figcaption></figure>');
    // Author styling wins — we never overwrite an explicit style.
    expect(attr(out, 'style')).toBe('max-width:600px;border-radius:8px');
    expect(attr(out, 'alt')).toBe('Essay figure');
    // The stale ?width= (which the endpoint ignores) is replaced by real ?w=.
    expect(out).not.toContain('width=1600');
    expect(attr(out, 'src')).toBe(`${ASSET}?w=${FALLBACK_WIDTH}`);
  });

  it('respects an author-supplied loading/decoding choice', () => {
    const out = rewriteResponsiveImages(`<img src="${ASSET}" loading="eager" decoding="sync">`);
    expect(out).toContain('loading="eager"');
    expect(out).toContain('decoding="sync"');
    expect(out).not.toContain('loading="lazy"');
  });

  it('handles single-quoted attributes and uppercase tag/attribute names', () => {
    const out = rewriteResponsiveImages(`<IMG SRC='${ASSET}' ALT='Shout'>`);
    expect(out).toContain(`?w=${FALLBACK_WIDTH}`);
    expect(out).toContain('srcset=');
    expect(out).toContain('ALT="Shout"');
  });

  it('handles a self-closing tag', () => {
    const out = rewriteResponsiveImages(`<img src="${ASSET}" />`);
    expect(out).toContain('srcset=');
    expect(out.endsWith('/>')).toBe(true);
  });

  it('tolerates a > inside a quoted attribute value', () => {
    const out = rewriteResponsiveImages(`<img src="${ASSET}" alt="a > b"><p>after</p>`);
    expect(out).toContain('alt="a > b"');
    expect(out).toContain('<p>after</p>');
    expect(out).toContain('srcset=');
  });

  it('escapes & when the source URL carries extra params', () => {
    const out = rewriteResponsiveImages(`<img src="${ASSET}?v=2">`);
    expect(out).toContain(`src="${ASSET}?v=2&amp;w=${FALLBACK_WIDTH}"`);
    expect(out).toContain(`srcset="${ASSET}?v=2&amp;w=400 400w,`);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const once = rewriteResponsiveImages(`<p><img src="${ASSET}" alt="x"></p>`);
    expect(rewriteResponsiveImages(once)).toBe(once);
  });
});
