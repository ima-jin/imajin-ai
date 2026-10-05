// @vitest-environment jsdom
/**
 * Profile register page — S9383 floating-promise fixes (#2568).
 *
 * Covers the two call sites that now go through `fireAndForget`: the DID
 * clipboard copy and the temporary-DID generation for image upload.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const keyState = { failRandom: false };

vi.mock('@noble/ed25519', () => ({
  utils: {
    randomSecretKey: () => {
      if (keyState.failRandom) throw new Error('no entropy');
      return new Uint8Array(32).fill(7);
    },
  },
  getPublicKeyAsync: async () => new Uint8Array(32).fill(1),
  signAsync: async () => new Uint8Array(64).fill(2),
}));

const identityState = {
  isLoggedIn: false,
  handle: null,
  did: null,
  importKeys: async () => ({ success: true }),
};
const searchParams = new URLSearchParams('invite=abc');

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => searchParams,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: Readonly<{ href: string; children: React.ReactNode }>) => <a href={href}>{children}</a>,
}));

vi.mock('@imajin/config', () => ({
  normalizeHandleInput: (v: string) => v,
  profilePath: (id: string) => `/${id}`,
}));

vi.mock('../../context/IdentityContext', () => ({
  useIdentity: () => identityState,
}));

vi.mock('../../components/ImageUpload', () => ({
  ImageUpload: ({ did }: { did: string | null }) => <div data-testid="image-upload">{did ?? 'no-did'}</div>,
}));

const { default: RegisterPage } = await import('../page');

const PROFILE_DID = 'did:imajin:registered';

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/profile/api/register') {
      return { ok: true, json: async () => ({ did: PROFILE_DID, handle: 'alice' }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }));
}

function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

async function registerAndShowSuccess() {
  installFetch();
  const view = render(<RegisterPage />);
  fireEvent.change(await screen.findByLabelText('Display Name *'), { target: { value: 'Alice' } });
  fireEvent.submit(view.container.querySelector('form')!);
  return screen.findByText('Welcome to Imajin!');
}

afterEach(() => {
  cleanup();
  keyState.failRandom = false;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DID copy', () => {
  it('writes the DID to the clipboard and shows the copied state', async () => {
    const writeText = vi.fn(async () => {});
    installClipboard(writeText);
    await registerAndShowSuccess();

    fireEvent.click(screen.getByText(PROFILE_DID));

    expect(writeText).toHaveBeenCalledWith(PROFILE_DID);
    expect(screen.getByText('✅ Copied!')).toBeDefined();
  });

  it('logs instead of rejecting when the clipboard write fails', async () => {
    const boom = new Error('clipboard denied');
    installClipboard(async () => { throw boom; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await registerAndShowSuccess();

    fireEvent.click(screen.getByText(PROFILE_DID));

    expect(screen.getByText('✅ Copied!')).toBeDefined();
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[profile:register:clipboard] unhandled async error', boom),
    );
  });
});

describe('temporary DID for image upload', () => {
  it('generates a temp DID when switching to image avatar mode', async () => {
    installFetch();
    render(<RegisterPage />);

    fireEvent.click(await screen.findByText('Or upload an image instead →'));

    await waitFor(() => expect(screen.getByTestId('image-upload').textContent).toMatch(/^did:imajin:/));
  });

  it('logs instead of rejecting when keypair generation fails', async () => {
    installFetch();
    keyState.failRandom = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<RegisterPage />);

    fireEvent.click(await screen.findByText('Or upload an image instead →'));

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        '[profile:register:generateTempDid] unhandled async error',
        expect.objectContaining({ message: 'no entropy' }),
      ),
    );
    expect(screen.getByTestId('image-upload').textContent).toBe('no-did');
  });
});
