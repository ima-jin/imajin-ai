// @vitest-environment jsdom
/**
 * Component tests for the /jin Front door lane (#2598): operator gate, tier /
 * topic / cap editing, the locked anonymous tier, dirty-tracked Save, the PUT
 * payload, error surfacing, discard, and refresh.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { FrontDoorPanel } from '../front-door-panel';

interface Topic { open: boolean; published: boolean; mode: 'deliver' | 'decline' }
interface Config {
  tiers: { anonymous: boolean; verified: boolean; attested: boolean };
  topics: Record<string, Topic>;
  dailyCap: number | null;
}

const OPTIONS = [
  { term: 'collaboration', label: 'Collaboration' },
  { term: 'speaking', label: 'Speaking engagement' },
];

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { anonymous: false, verified: false, attested: false },
    topics: {
      collaboration: { open: false, published: false, mode: 'deliver' },
      speaking: { open: false, published: false, mode: 'deliver' },
    },
    dailyCap: 25,
    ...overrides,
  };
}

interface FetchOptions {
  get?: { ok: boolean; body: unknown } | 'throw';
  put?: { ok: boolean; status?: number; body: unknown } | 'badjson';
}

function installFetch({ get, put }: FetchOptions = {}) {
  const getResult = get ?? { ok: true, body: { isOperator: true, config: config(), topicOptions: OPTIONS, limits: { minDailyCap: 1, maxDailyCap: 1000 } } };
  const spy = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (put === 'badjson') {
        return Promise.resolve({ ok: false, status: 500, json: async () => { throw new Error('no body'); } } as unknown as Response);
      }
      const result = put ?? { ok: true, body: { isOperator: true, config: JSON.parse(String(init.body)) } };
      return Promise.resolve({ ok: result.ok, status: result.status ?? (result.ok ? 200 : 400), json: async () => result.body } as unknown as Response);
    }
    if (getResult === 'throw') return Promise.reject(new Error('network'));
    return Promise.resolve({ ok: getResult.ok, status: getResult.ok ? 200 : 401, json: async () => getResult.body } as unknown as Response);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function putCalls(spy: ReturnType<typeof installFetch>) {
  return spy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('operator gate', () => {
  it('renders nothing for a non-operator', async () => {
    const spy = installFetch({ get: { ok: true, body: { isOperator: false } } });
    const { container } = render(<FrontDoorPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the request fails or is rejected', async () => {
    installFetch({ get: { ok: false, body: {} } });
    const first = render(<FrontDoorPanel />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(first.container.firstChild).toBeNull();
    cleanup();

    installFetch({ get: 'throw' });
    const second = render(<FrontDoorPanel />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(second.container.firstChild).toBeNull();
  });

  it('renders the lane for the operator', async () => {
    installFetch();
    render(<FrontDoorPanel />);
    expect(await screen.findByText('Front door')).toBeDefined();
    expect(screen.getByTestId('front-door-topic-collaboration')).toBeDefined();
    expect(screen.getByTestId('front-door-topic-speaking')).toBeDefined();
  });
});

describe('tiers', () => {
  it('locks the anonymous tier (reach card only)', async () => {
    installFetch();
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');
    const anonymous = screen.getByTestId('front-door-tier-anonymous').querySelector('input') as HTMLInputElement;
    expect(anonymous.disabled).toBe(true);
    expect(anonymous.checked).toBe(false);
    expect(screen.getByText('locked')).toBeDefined();
  });

  it('toggles verified and attested', async () => {
    installFetch();
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');
    const verified = screen.getByTestId('front-door-tier-verified').querySelector('input') as HTMLInputElement;
    fireEvent.click(verified);
    expect(verified.checked).toBe(true);
  });
});

describe('topics', () => {
  it('disables publish and mode until a topic is open, and clears publish when it is closed again', async () => {
    installFetch();
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');

    const publish = screen.getByLabelText('Publish Collaboration on card') as HTMLInputElement;
    const mode = screen.getByLabelText('Mode for Collaboration') as HTMLSelectElement;
    expect(publish.disabled).toBe(true);
    expect(mode.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Open Collaboration'));
    expect(publish.disabled).toBe(false);
    expect(mode.disabled).toBe(false);
    expect(mode.value).toBe('deliver');

    fireEvent.click(publish);
    expect(publish.checked).toBe(true);

    fireEvent.click(screen.getByLabelText('Open Collaboration'));
    expect(publish.checked).toBe(false);
  });
});

describe('daily cap', () => {
  it('can be removed and re-enabled with the default', async () => {
    installFetch();
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');
    expect((screen.getByLabelText('Daily cap') as HTMLInputElement).value).toBe('25');

    fireEvent.click(screen.getByLabelText('Limit messages per day'));
    expect(screen.queryByLabelText('Daily cap')).toBeNull();

    fireEvent.click(screen.getByLabelText('Limit messages per day'));
    expect((screen.getByLabelText('Daily cap') as HTMLInputElement).value).toBe('25');
  });

  it('blocks Save and explains an out-of-range cap', async () => {
    installFetch();
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');
    fireEvent.change(screen.getByLabelText('Daily cap'), { target: { value: '5000' } });
    expect(screen.getByText(/Enter a whole number from 1 to 1000/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('save', () => {
  it('is disabled until something changes', async () => {
    installFetch();
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('PUTs the whole draft and confirms it is live on the next call', async () => {
    const spy = installFetch();
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');

    fireEvent.click(screen.getByTestId('front-door-tier-verified').querySelector('input') as HTMLInputElement);
    fireEvent.click(screen.getByLabelText('Open Collaboration'));
    fireEvent.click(screen.getByLabelText('Publish Collaboration on card'));
    fireEvent.change(screen.getByLabelText('Mode for Collaboration'), { target: { value: 'decline' } });
    fireEvent.change(screen.getByLabelText('Daily cap'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Front door saved — live on the next call.')).toBeDefined();
    const calls = putCalls(spy);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/jin/api/front-door');
    expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({
      tiers: { anonymous: false, verified: true, attested: false },
      topics: {
        collaboration: { open: true, published: true, mode: 'decline' },
        speaking: { open: false, published: false, mode: 'deliver' },
      },
      dailyCap: 10,
    });
    // Saved state is now the baseline again.
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces the server error and keeps the draft', async () => {
    installFetch({ put: { ok: false, body: { error: 'dailyCap must be null or an integer between 1 and 1000' } } });
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');
    fireEvent.click(screen.getByTestId('front-door-tier-attested').querySelector('input') as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('dailyCap must be null or an integer between 1 and 1000')).toBeDefined();
    expect((screen.getByTestId('front-door-tier-attested').querySelector('input') as HTMLInputElement).checked).toBe(true);
  });

  it('falls back to a status message when the error body is not JSON', async () => {
    installFetch({ put: 'badjson' });
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');
    fireEvent.click(screen.getByTestId('front-door-tier-attested').querySelector('input') as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Save failed (500)')).toBeDefined();
  });
});

describe('discard and refresh', () => {
  it('discards unsaved edits', async () => {
    installFetch();
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');
    const verified = screen.getByTestId('front-door-tier-verified').querySelector('input') as HTMLInputElement;
    fireEvent.click(verified);
    fireEvent.click(screen.getByText('discard changes'));
    expect(verified.checked).toBe(false);
    expect(screen.queryByText('discard changes')).toBeNull();
  });

  it('refresh re-reads the saved config', async () => {
    const spy = installFetch();
    render(<FrontDoorPanel />);
    await screen.findByText('Front door');
    fireEvent.click(screen.getByText('↺ refresh'));
    await waitFor(() => expect(spy.mock.calls.length - putCalls(spy).length).toBe(2));
  });
});
