// @vitest-environment jsdom
/**
 * Smoke-render test for `PasswordAuthTab`. Both steps ('identifier' and
 * 'password') mount an input that carries the shared focus-on-mount ref
 * callback (S9379); only one is ever mounted at a time.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import PasswordAuthTab from '../PasswordAuthTab';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PasswordAuthTab', () => {
  it('renders the handle input, focusing it on mount, without crashing', () => {
    render(
      <PasswordAuthTab nextUrl={null} onMfaRequired={vi.fn()} onSuccess={vi.fn()} />,
    );

    const input = screen.getByLabelText('Handle');
    expect(input).toBeDefined();
    expect(document.activeElement).toBe(input);
  });

  it('renders the password input, focusing it on mount, once the handle look-up finds a stored key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        hasStoredKey: true,
        did: 'did:imajin:alice',
        encryptedKey: 'ZW5j',
        salt: 'c2FsdA==',
        keyDerivation: 'pbkdf2',
      }),
    })));

    render(
      <PasswordAuthTab nextUrl={null} onMfaRequired={vi.fn()} onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const input = await screen.findByLabelText('Password');
    expect(input).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});
