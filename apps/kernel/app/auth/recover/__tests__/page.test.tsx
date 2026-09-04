// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import RecoverPage from '../page';

vi.mock('next/link', () => ({
  default: ({ href, children }: Readonly<{ href: string; children: React.ReactNode }>) => (
    <a href={href}>{children}</a>
  ),
}));

const h = vi.hoisted(() => ({
  generateKeypair: vi.fn(),
  sign: vi.fn(),
}));

vi.mock('@/src/lib/auth/browser-keys', () => ({
  generateKeypair: h.generateKeypair,
  sign: h.sign,
}));

type JsonBody = Record<string, unknown>;

function jsonResponse(body: JsonBody, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

const DID = 'did:imajin:recoverable';
const KEYPAIR = { publicKey: 'b'.repeat(64), privateKey: 'a'.repeat(64) };

async function fillAndSubmit(code = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG') {
  fireEvent.change(screen.getByLabelText('Your DID'), { target: { value: DID } });
  fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: code } });
  fireEvent.click(screen.getByText('Recover account'));
}

beforeEach(() => {
  h.generateKeypair.mockResolvedValue(KEYPAIR);
  h.sign.mockResolvedValue('deadbeef'.repeat(8));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RecoverPage — happy path', () => {
  it('generates a keypair, proves it against the challenge, redeems the code, and offers a key backup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/auth/api/recovery-codes/challenge')) {
          return jsonResponse({ challengeId: 'rchl_1', challenge: 'the-challenge' });
        }
        if (url === '/auth/api/recovery-codes/verify') {
          return jsonResponse({ rotated: true, sessionsInvalidated: true, chainDeprecated: false });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(<RecoverPage />);
    await fillAndSubmit();

    expect(await screen.findByText('Back up your new key')).toBeDefined();
    expect(h.generateKeypair).toHaveBeenCalledOnce();
    expect(h.sign).toHaveBeenCalledWith('the-challenge', KEYPAIR.privateKey);
  });

  it('proceeds to the signed-in confirmation only after the key has been downloaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ challengeId: 'rchl_1', challenge: 'the-challenge', rotated: true })),
    );
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();

    render(<RecoverPage />);
    await fillAndSubmit();
    await screen.findByText('Back up your new key');

    const continueButton = screen.getByText('✓ Continue to sign in') as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    fireEvent.click(screen.getByText('📥 Download Backup Key'));
    await waitFor(() => expect(continueButton.disabled).toBe(false));

    fireEvent.click(continueButton);
    expect(await screen.findByText('Your account has been recovered')).toBeDefined();
    expect(localStorage.getItem('imajin_did')).toBe(DID);
  });
});

describe('RecoverPage — failure paths', () => {
  it('shows a validation error and never calls the API when a field is only whitespace', async () => {
    // Whitespace satisfies the input's native `required` constraint, so the
    // form actually submits — this exercises the component's own `.trim()`
    // guard rather than the browser's constraint validation.
    render(<RecoverPage />);
    fireEvent.change(screen.getByLabelText('Your DID'), { target: { value: DID } });
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Recover account'));

    expect(await screen.findByText('Enter your DID and a recovery code.')).toBeDefined();
    expect(h.generateKeypair).not.toHaveBeenCalled();
  });

  it('surfaces the server error when the challenge request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Identity not found' }, false)));

    render(<RecoverPage />);
    await fillAndSubmit();

    expect(await screen.findByText('Identity not found')).toBeDefined();
  });

  it('surfaces the generic recovery-failed error when redemption is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/auth/api/recovery-codes/challenge')) {
          return jsonResponse({ challengeId: 'rchl_1', challenge: 'the-challenge' });
        }
        return jsonResponse({ error: 'Invalid recovery code' }, false);
      }),
    );

    render(<RecoverPage />);
    await fillAndSubmit();

    expect(await screen.findByText('Invalid recovery code')).toBeDefined();
  });

  it('falls back to a generic message when the challenge request fails without an error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false)));

    render(<RecoverPage />);
    await fillAndSubmit();

    expect(await screen.findByText('Could not start recovery — check your DID.')).toBeDefined();
  });

  it('falls back to a generic message when redemption fails without an error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/auth/api/recovery-codes/challenge')) {
          return jsonResponse({ challengeId: 'rchl_1', challenge: 'the-challenge' });
        }
        return jsonResponse({}, false);
      }),
    );

    render(<RecoverPage />);
    await fillAndSubmit();

    expect(await screen.findByText('Recovery failed. Check your code and try again.')).toBeDefined();
  });

  it('falls back to a generic message when a non-Error value is thrown', async () => {
    h.generateKeypair.mockRejectedValue('not an Error instance');

    render(<RecoverPage />);
    await fillAndSubmit();

    expect(await screen.findByText('Recovery failed')).toBeDefined();
  });
});
