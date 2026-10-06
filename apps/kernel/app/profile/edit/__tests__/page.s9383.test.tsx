// @vitest-environment jsdom
/**
 * Profile edit page — S9383 floating-promise fix (#2568).
 *
 * The mount effect fires `loadProfile()` without awaiting it; it now goes
 * through `fireAndForget`. Behaviour is unchanged and a rejection is logged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const DID = 'did:imajin:alice';

// Stable references: these feed effect dependency arrays.
const identityState = {
  did: DID,
  isLoggedIn: true,
  isLoading: false,
  refreshProfile: async () => {},
};
const searchParams = new URLSearchParams();
const router = { push: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => searchParams,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: Readonly<{ href: string; children: React.ReactNode }>) => <a href={href}>{children}</a>,
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
  profilePath: (id: string) => `/${id}`,
}));

vi.mock('../../context/IdentityContext', () => ({
  useIdentity: () => identityState,
}));

vi.mock('../../components/ImageUpload', () => ({
  ImageUpload: () => null,
}));

const { default: EditProfilePage } = await import('../page');

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('profile load on mount', () => {
  it('loads the profile into the form', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/auth/api/session') return jsonResponse({ tier: 'verified' });
      if (url === `/profile/api/profile/${DID}`) {
        return jsonResponse({ did: DID, displayName: 'Alice', bio: 'hi', handle: 'alice' });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<EditProfilePage />);

    const field = (await screen.findByLabelText('Display Name *')) as HTMLInputElement;
    expect(field.value).toBe('Alice');
    expect(fetchSpy).toHaveBeenCalledWith(`/profile/api/profile/${DID}`);
  });

  it('logs through fireAndForget instead of rejecting when loadProfile itself throws', async () => {
    const boom = new Error('console broke');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      // The page's own catch-block log: make it throw so loadProfile() rejects.
      if (args[0] === 'Failed to load profile:') throw boom;
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/auth/api/session') return jsonResponse({});
      return jsonResponse({}, { ok: false, status: 500 });
    }));

    render(<EditProfilePage />);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[profile:edit:loadProfile] unhandled async error', boom),
    );
    // `finally` still ran, so the page left its loading state.
    await waitFor(() => expect(screen.queryByText('Loading profile...')).toBeNull());
  });
});
