// @vitest-environment jsdom
/**
 * ArticleMetadata (#1445).
 *
 * The badge/expand/edit panel reads the derived `metadata.article` projection
 * (never re-parses the raw file) and, when editing, saves strictly through
 * the existing PATCH /media/api/assets/[id]/article route — this component
 * never builds YAML itself. Edit affordance is owner-only, reusing the same
 * `isOwner` check the rest of the asset viewer uses.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { ArticleMetadata, readArticleMetadata, type ArticleMetadataBlock } from '../ArticleMetadata';
import type { Asset } from '@/src/db/schemas/media';

const ASSET_ID = 'asset_abc123';

const ARTICLE: ArticleMetadataBlock = {
  slug: 'hello-world',
  title: 'Hello, World',
  subtitle: 'A subtitle',
  status: 'DRAFT',
  date: '2026-06-29',
};

function makeAsset(article: ArticleMetadataBlock | null, overrides: Partial<Asset> = {}): Asset {
  return {
    id: ASSET_ID,
    ownerDid: 'did:imajin:owner',
    filename: 'hello-world.md',
    mimeType: 'text/markdown',
    metadata: article ? { article } : {},
    ...overrides,
  } as unknown as Asset;
}

function installFetch(status = 200, body: unknown = {}) {
  const spy = vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  }) as unknown as Response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('badge visibility', () => {
  it('renders nothing when the asset has no article metadata', () => {
    const { container } = render(<ArticleMetadata asset={makeAsset(null)} isOwner />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the "Has metadata" badge when metadata.article is present', () => {
    render(<ArticleMetadata asset={makeAsset(ARTICLE)} isOwner={false} />);
    expect(screen.getByText('Has metadata')).toBeDefined();
  });

  it('does not offer Edit to a non-owner', () => {
    render(<ArticleMetadata asset={makeAsset(ARTICLE)} isOwner={false} />);
    expect(screen.queryByText('Edit ✏️')).toBeNull();
  });

  it('offers Edit to the owner', () => {
    render(<ArticleMetadata asset={makeAsset(ARTICLE)} isOwner />);
    expect(screen.getByText('Edit ✏️')).toBeDefined();
  });
});

describe('read-only expanded view', () => {
  it('shows the article fields when the badge is clicked', () => {
    render(<ArticleMetadata asset={makeAsset(ARTICLE)} isOwner={false} />);
    fireEvent.click(screen.getByText('Has metadata'));

    const list = screen.getByText('Slug').closest('dl') as HTMLElement;
    expect(within(list).getByText('hello-world')).toBeDefined();
    expect(within(list).getByText('Hello, World')).toBeDefined();
    expect(within(list).getByText('A subtitle')).toBeDefined();
    expect(within(list).getByText('DRAFT')).toBeDefined();
    // Never renders the raw YAML delimiters.
    expect(screen.queryByText(/^---/)).toBeNull();
  });

  it('omits empty optional fields', () => {
    render(<ArticleMetadata asset={makeAsset({ ...ARTICLE, subtitle: undefined, description: undefined })} isOwner={false} />);
    fireEvent.click(screen.getByText('Has metadata'));
    expect(screen.queryByText('Subtitle')).toBeNull();
    expect(screen.queryByText('Description')).toBeNull();
  });
});

describe('editing', () => {
  it('pre-fills the form from the current metadata', () => {
    render(<ArticleMetadata asset={makeAsset(ARTICLE)} isOwner />);
    fireEvent.click(screen.getByText('Edit ✏️'));

    expect(screen.getByDisplayValue('hello-world')).toBeDefined();
    expect(screen.getByDisplayValue('Hello, World')).toBeDefined();
    expect(screen.getByDisplayValue('A subtitle')).toBeDefined();
  });

  it('validates the slug client-side without calling the API', async () => {
    const spy = installFetch();
    render(<ArticleMetadata asset={makeAsset(ARTICLE)} isOwner />);
    fireEvent.click(screen.getByText('Edit ✏️'));

    fireEvent.change(screen.getByDisplayValue('hello-world'), { target: { value: 'Bad Slug' } });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Slug must be URL-safe (a-z, 0-9, hyphens only)',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('PATCHes the edited fields and reports the updated asset', async () => {
    const updatedAsset = makeAsset({ ...ARTICLE, title: 'New Title' });
    const spy = installFetch(200, updatedAsset);
    const onSaved = vi.fn();
    render(<ArticleMetadata asset={makeAsset(ARTICLE)} isOwner onSaved={onSaved} />);

    fireEvent.click(screen.getByText('Edit ✏️'));
    fireEvent.change(screen.getByDisplayValue('Hello, World'), { target: { value: 'New Title' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updatedAsset));
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/media/api/assets/${ASSET_ID}/article`);
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(String(init.body));
    expect(sent.title).toBe('New Title');
    expect(sent.slug).toBe('hello-world');
    // Closes the editor back to the read-only view.
    expect(screen.queryByDisplayValue('New Title')).toBeNull();
  });

  it('surfaces a server error and keeps the form open', async () => {
    installFetch(400, { error: 'slug is required and must be URL-safe (a-z, 0-9, hyphens only)' });
    render(<ArticleMetadata asset={makeAsset(ARTICLE)} isOwner />);

    fireEvent.click(screen.getByText('Edit ✏️'));
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'slug is required and must be URL-safe (a-z, 0-9, hyphens only)',
    );
    // Still editing.
    expect(screen.getByText('Save')).toBeDefined();
  });

  it('cancel discards edits and returns to the read-only view', () => {
    render(<ArticleMetadata asset={makeAsset(ARTICLE)} isOwner />);
    fireEvent.click(screen.getByText('Edit ✏️'));
    fireEvent.change(screen.getByDisplayValue('Hello, World'), { target: { value: 'Discarded' } });
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByDisplayValue('Discarded')).toBeNull();
    expect(screen.getByText('Hello, World')).toBeDefined();
  });
});

describe('readArticleMetadata', () => {
  it('returns null when metadata.article is missing slug/title', () => {
    const asset = makeAsset(null, { metadata: { article: { status: 'DRAFT' } } } as Partial<Asset>);
    expect(readArticleMetadata(asset)).toBeNull();
  });

  it('returns the block when it has slug and title', () => {
    const asset = makeAsset(ARTICLE);
    expect(readArticleMetadata(asset)).toEqual(ARTICLE);
  });
});
