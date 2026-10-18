// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDENTITY_CATEGORIES } from '@imajin/config';
import NewGroupPage from '../page';

const navigation = vi.hoisted(() => ({ scope: 'business' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams({ scope: navigation.scope }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  navigation.scope = 'business';
});

function categoryPicker() {
  return screen.getByLabelText('Category').parentElement!;
}

describe('Create Identity organization categories', () => {
  it('renders the shared taxonomy, including trades and services, without requiring custom text', () => {
    render(<NewGroupPage />);

    const options = Array.from(categoryPicker().querySelectorAll('button'));
    expect(options.map(option => option.textContent)).toEqual([...IDENTITY_CATEGORIES]);
    expect(options.map(option => option.textContent)).toEqual(
      expect.arrayContaining(['contractor', 'trades', 'professional services', 'health', 'café']),
    );
  });

  it.each(['contractor', 'trades', 'professional services', 'health', 'café'])(
    'submits the selected %s category unchanged',
    async (category) => {
      // Keep the form on screen after the request so jsdom need not navigate.
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Handle already taken' }),
      });
      vi.stubGlobal('fetch', fetchSpy);
      render(<NewGroupPage />);

      fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'GBS Contracting' } });
      const option = Array.from(categoryPicker().querySelectorAll('button'))
        .find(button => button.textContent === category)!;
      fireEvent.click(option);
      expect(option.getAttribute('aria-pressed')).toBe('true');
      expect((screen.getByLabelText('Category') as HTMLInputElement).value).toBe(category);
      fireEvent.click(screen.getByRole('button', { name: 'Create Identity' }));

      await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('/auth/api/groups');
      expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
      expect(JSON.parse(init.body)).toMatchObject({
        scope: 'business', name: 'GBS Contracting', category,
      });
      await screen.findByText('Handle already taken');
    },
  );

  it('can deselect a category', () => {
    render(<NewGroupPage />);
    const option = screen.getByRole('button', { name: 'trades' });
    fireEvent.click(option);
    fireEvent.click(option);
    expect(option.getAttribute('aria-pressed')).toBe('false');
    expect((screen.getByLabelText('Category') as HTMLInputElement).value).toBe('');
  });

  it.each(['community', 'family'])('does not show business categories for %s', (scope) => {
    navigation.scope = scope;
    render(<NewGroupPage />);
    expect(screen.queryByLabelText('Category')).toBeNull();
  });
});
