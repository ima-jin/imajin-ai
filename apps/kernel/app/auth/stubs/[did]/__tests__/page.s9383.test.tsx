// @vitest-environment jsdom
/**
 * EditStubPage — typescript:S9383 (#2568).
 *
 * The mount fetch, avatar/banner upload and gallery upload handlers are
 * wrapped in `fireAndForget(...)`. These tests pin that each path still runs
 * unchanged and that a rejected mount fetch is logged via console.error
 * instead of becoming an unhandled rejection.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const STUB_DID = 'did:imajin:stub1';

vi.mock('next/navigation', () => ({
  useParams: () => ({ did: encodeURIComponent('did:imajin:stub1') }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

vi.mock('@imajin/config', () => ({
  normalizeHandleInput: (v: string) => v,
  profilePath: (v: string) => `/${v}`,
}));

import EditStubPage from '../page';

function res(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

function installFetch() {
  const spy = vi.fn(async (rawUrl: string, init?: RequestInit) => {
    const url = String(rawUrl);
    if (url === '/profile/api/stubs/mine') {
      return res([{ did: STUB_DID, name: 'My Cafe', handle: 'cafe', bio: '', metadata: {} }]);
    }
    if (url === `/profile/api/stubs/${STUB_DID}/images` && init?.method === 'POST') {
      return res({ image: { id: 'img1', url: 'https://cdn.test/g.png' } });
    }
    if (url.endsWith('/images')) return res({ images: [] });
    if (url === '/media/api/assets') return res({ url: 'https://cdn.test/up.png' });
    return res({});
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function renderLoaded() {
  const fetchSpy = installFetch();
  const utils = render(<EditStubPage />);
  await waitFor(() => expect(screen.getByText('0 / 6 images')).toBeDefined());
  const inputs = utils.container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  return { fetchSpy, avatarInput: inputs[0], bannerInput: inputs[1], galleryInput: inputs[2] };
}

function pick(input: HTMLInputElement) {
  fireEvent.change(input, { target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EditStubPage fire-and-forget calls', () => {
  it('loads the stub and its images on mount', async () => {
    const { fetchSpy } = await renderLoaded();

    expect(fetchSpy).toHaveBeenCalledWith('/profile/api/stubs/mine', { credentials: 'include' });
    expect(fetchSpy).toHaveBeenCalledWith(`/profile/api/stubs/${STUB_DID}/images`, { credentials: 'include' });
  });

  it('logs a rejected mount fetch through console.error without unhandled rejection', async () => {
    const err = new Error('offline');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(err)));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(<EditStubPage />);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[auth:stubs:fetchData] unhandled async error', err),
    );
    await waitFor(() => expect(screen.getByText(/Place not found/)).toBeDefined());
  });

  it('uploads an avatar and saves it on the stub', async () => {
    const { fetchSpy, avatarInput } = await renderLoaded();
    pick(avatarInput);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/profile/api/stubs/${encodeURIComponent(STUB_DID)}`,
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ avatar: 'https://cdn.test/up.png' }) }),
      ),
    );
    await waitFor(() => expect(screen.getByText('Change avatar')).toBeDefined());
  });

  it('uploads a banner and saves it on the stub', async () => {
    const { fetchSpy, bannerInput } = await renderLoaded();
    pick(bannerInput);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/profile/api/stubs/${encodeURIComponent(STUB_DID)}`,
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ banner: 'https://cdn.test/up.png' }) }),
      ),
    );
    await waitFor(() => expect(screen.getByText('Change banner')).toBeDefined());
  });

  it('uploads a gallery image and adds it to the gallery', async () => {
    const { galleryInput } = await renderLoaded();
    pick(galleryInput);

    await waitFor(() => expect(screen.getByText('1 / 6 images')).toBeDefined());
  });
});
