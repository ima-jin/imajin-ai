// @vitest-environment jsdom
/**
 * FileEditor frontmatter hiding (#1445).
 *
 * Markdown assets carrying a `---` YAML frontmatter header must never show
 * that raw header in the editor or preview, and editing the body must never
 * destroy it (or any keys it carries that the structured metadata editor
 * doesn't know about) — the header is split off and reattached verbatim,
 * never re-parsed or re-serialized here.
 *
 * The real react-simple-code-editor / prismjs / react-markdown are used
 * (rather than mocked): prismjs's component files rely on a real `require`d
 * `prismjs` having set a global `Prism`, which module mocking of individual
 * files does not preserve, and the editor/markdown libraries are plain,
 * jsdom-safe React components.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Asset } from '@/src/db/schemas/media';
import { FileEditor } from '../FileEditor';

const ASSET_ID = 'asset_md_1';
const HEADER = '---\nslug: "hello"\ntitle: "Hello"\nstatus: "DRAFT"\ndate: "2026-01-01"\ncustomKey: "kept"\n---\n';
const BODY = '# Heading\n\nBody text.';
const RAW_FILE = `${HEADER}${BODY}`;

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: ASSET_ID,
    filename: 'hello.md',
    mimeType: 'text/markdown',
    ...overrides,
  } as unknown as Asset;
}

function installContentFetch(raw: string) {
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => raw } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function findEditorTextarea(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(() => {
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('editor textarea not mounted yet');
    return textarea;
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hiding frontmatter', () => {
  it('never shows the raw --- header in the editor', async () => {
    installContentFetch(RAW_FILE);
    const { container } = render(<FileEditor asset={makeAsset()} isOwner />);

    const editor = await findEditorTextarea(container);
    expect(editor.value).toBe(BODY);
    expect(editor.value).not.toContain('customKey');
    expect(editor.value).not.toContain('---');
  });

  it('never shows the raw --- header in the preview', async () => {
    installContentFetch(RAW_FILE);
    const { container } = render(<FileEditor asset={makeAsset()} isOwner />);

    await findEditorTextarea(container);
    fireEvent.click(screen.getByText('Preview'));

    await waitFor(() => expect(screen.getByText('Heading')).toBeDefined());
    expect(container.textContent).not.toContain('customKey');
    expect(container.textContent).not.toContain('---');
    expect(screen.getByText('Body text.')).toBeDefined();
  });

  it('shows a hidden-frontmatter hint when a header is present', async () => {
    installContentFetch(RAW_FILE);
    const { container } = render(<FileEditor asset={makeAsset()} isOwner />);
    await findEditorTextarea(container);
    expect(screen.getByText('frontmatter hidden')).toBeDefined();
  });

  it('shows no hint for a plain note with no frontmatter', async () => {
    installContentFetch(BODY);
    const { container } = render(<FileEditor asset={makeAsset()} isOwner />);
    await findEditorTextarea(container);
    expect(screen.queryByText('frontmatter hidden')).toBeNull();
  });

  it('leaves non-markdown text files untouched', async () => {
    const jsonRaw = '{"a":1}';
    installContentFetch(jsonRaw);
    const { container } = render(
      <FileEditor asset={makeAsset({ filename: 'data.json', mimeType: 'application/json' })} isOwner />
    );

    const editor = await findEditorTextarea(container);
    expect(editor.value).toBe(jsonRaw);
    expect(screen.queryByText('frontmatter hidden')).toBeNull();
  });
});

describe('preserving frontmatter on save', () => {
  it('reattaches the original header verbatim, unchanged, when only the body is edited', async () => {
    const spy = installContentFetch(RAW_FILE);
    const { container } = render(<FileEditor asset={makeAsset()} isOwner />);

    const editor = await findEditorTextarea(container);
    fireEvent.change(editor, { target: { value: '# Heading\n\nEdited body.' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCall = spy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
      expect(putCall).toBeDefined();
    });
    const putCall = spy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    expect(putCall[0]).toBe(`/media/api/assets/${ASSET_ID}/content`);
    const sent = JSON.parse(String((putCall[1] as RequestInit).body));
    expect(sent.content).toBe(`${HEADER}# Heading\n\nEdited body.`);
    // The header text — including the unknown key — is byte-identical to the original.
    expect(sent.content.startsWith(HEADER)).toBe(true);
    expect(sent.content).toContain('customKey: "kept"');
  });

  it('saves an unmodified-header body as a plain string when there is no frontmatter', async () => {
    const spy = installContentFetch(BODY);
    const { container } = render(<FileEditor asset={makeAsset()} isOwner />);

    const editor = await findEditorTextarea(container);
    fireEvent.change(editor, { target: { value: 'Edited note.' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCall = spy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
      expect(putCall).toBeDefined();
    });
    const putCall = spy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    const sent = JSON.parse(String((putCall[1] as RequestInit).body));
    expect(sent.content).toBe('Edited note.');
  });
});
