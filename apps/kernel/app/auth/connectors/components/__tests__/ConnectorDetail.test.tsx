// @vitest-environment jsdom
/**
 * ConnectorDetail render tests (#1604).
 *
 * The dispatcher bug this PR fixes was invisible to every existing test: the
 * registry said Gemini was live, the backend routes were live, and the page still
 * rendered "Coming soon" because the card was chosen by a hand-maintained id
 * list. `connector-card-dispatch.test.ts` guards the routing decision; these
 * tests guard what the chosen card actually does — which credential goes to which
 * route, under which body key, with which verb.
 *
 * These are the first component tests in the repo, hence the local fetch/confirm
 * harness rather than a shared setup file.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { getConnector, type ConnectorEntry } from '@/src/lib/kernel/connector-registry';
import { ConnectorDetail } from '../ConnectorDetail';

// The OAuth cards read the connect-outcome query string. Nothing under test here
// depends on its contents, but `useSearchParams` needs a Next router context that
// does not exist outside the app runtime.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

// ── Harness ───────────────────────────────────────────────────────────────────

type StatusBody = Record<string, unknown>;

function jsonResponse(body: StatusBody, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: async () => body,
  } as unknown as Response;
}

/**
 * Stub `fetch` with a URL → body map. Any URL not in the map resolves to an empty
 * success body, which is what the seal and disconnect routes return.
 */
function installFetch(bodies: Record<string, StatusBody>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return jsonResponse(bodies[url] ?? {});
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/**
 * Parse the JSON body of the most recent recorded call to `url`.
 *
 * Skips bodyless calls: a status endpoint is fetched on mount (GET) before it is
 * written to (POST), so matching on URL alone finds the wrong request.
 */
function requestBody(spy: ReturnType<typeof installFetch>, url: string): unknown {
  const call = spy.mock.calls.findLast(
    ([input, init]) => String(input) === url && (init as RequestInit | undefined)?.body != null,
  );
  if (!call) throw new Error(`no request with a body recorded for ${url}`);
  return JSON.parse(String((call[1] as RequestInit).body));
}

function entryFor(id: string): ConnectorEntry {
  const entry = getConnector(id);
  if (!entry) throw new Error(`${id} missing from the registry`);
  return entry;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── The bug this PR fixes ─────────────────────────────────────────────────────

describe('#1604 — live connectors render a setable card, not "Coming soon"', () => {
  it('renders Gemini as a token-paste card', async () => {
    installFetch({
      '/gemini/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['gemini:infer'],
        keySealed: false,
      },
    });

    render(<ConnectorDetail entry={entryFor('gemini')} />);

    expect(await screen.findByPlaceholderText('Gemini API Key')).toBeDefined();
    expect(screen.getByText('gemini:infer')).toBeDefined();
    // The symptom in the issue: the pending card's badge.
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('renders Warp as a static-secret card', async () => {
    installFetch({
      '/warp/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['warp:dispatch'],
        keySealed: false,
      },
    });

    render(<ConnectorDetail entry={entryFor('warp')} />);

    expect(await screen.findByPlaceholderText('Warp Agent Key')).toBeDefined();
    expect(screen.getByText('warp:dispatch')).toBeDefined();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('keeps Discord rendering the copy it had before the card was generalised', async () => {
    installFetch({
      '/discord/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['discord:post', 'discord:read'],
        tokenSealed: false,
      },
    });

    render(<ConnectorDetail entry={entryFor('discord')} />);

    expect(await screen.findByPlaceholderText('Discord Bot Token')).toBeDefined();
    expect(screen.getByText(/Discord Developer Portal/)).toBeDefined();
  });
});

// ── Credential sealing ────────────────────────────────────────────────────────

describe('sealing a credential', () => {
  async function sealAndReturnSpy(id: string, statusBody: StatusBody, placeholder: string, value: string) {
    const entry = entryFor(id);
    const spy = installFetch({ [entry.statusEndpoint!]: statusBody });

    render(<ConnectorDetail entry={entry} />);
    const input = await screen.findByPlaceholderText(placeholder);
    fireEvent.change(input, { target: { value } });
    // Submitting the form directly rather than clicking: jsdom does not implement
    // the full form-submission algorithm, so a click on the submit button is not a
    // reliable way to fire React's onSubmit.
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    return spy;
  }

  it('posts a token-paste credential under the `token` key', async () => {
    const spy = await sealAndReturnSpy(
      'gemini',
      { manifestAssetId: null, activeScopes: [], validScopes: ['gemini:infer'], keySealed: false },
      'Gemini API Key',
      'test-api-key',
    );

    await waitFor(() => {
      expect(requestBody(spy, '/gemini/api/token')).toEqual({ token: 'test-api-key' });
    });
  });

  it('posts a static-secret credential under the `secret` key', async () => {
    const spy = await sealAndReturnSpy(
      'warp',
      { manifestAssetId: null, activeScopes: [], validScopes: ['warp:dispatch'], keySealed: false },
      'Warp Agent Key',
      'test-agent-key',
    );

    await waitFor(() => {
      expect(requestBody(spy, '/warp/api/seal')).toEqual({ secret: 'test-agent-key' });
    });
  });

  it('trims the pasted value', async () => {
    const spy = await sealAndReturnSpy(
      'discord',
      { manifestAssetId: null, activeScopes: [], validScopes: ['discord:post'], tokenSealed: false },
      'Discord Bot Token',
      '  padded-token  ',
    );

    await waitFor(() => {
      expect(requestBody(spy, '/discord/api/token')).toEqual({ token: 'padded-token' });
    });
  });

  it('surfaces a seal failure instead of clearing the field', async () => {
    const entry = entryFor('gemini');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === entry.tokenRoute) {
          return jsonResponse({ error: 'token must be a non-empty string' }, false);
        }
        return jsonResponse({
          manifestAssetId: null,
          activeScopes: [],
          validScopes: ['gemini:infer'],
          keySealed: false,
        });
      }),
    );

    render(<ConnectorDetail entry={entry} />);
    const input = await screen.findByPlaceholderText('Gemini API Key');
    fireEvent.change(input, { target: { value: 'bad' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(await screen.findByText(/token must be a non-empty string/)).toBeDefined();
  });
});

// ── Sealed state, read from whichever flag the backend reports ─────────────────

describe('sealed credential status', () => {
  it('reads Gemini\'s `keySealed`', async () => {
    installFetch({
      '/gemini/api/scope-manifest': {
        manifestAssetId: 'asset-1',
        activeScopes: [],
        validScopes: ['gemini:infer'],
        keySealed: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('gemini')} />);

    expect(await screen.findByText('API Key sealed')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDefined();
  });

  it('reveals the input to replace a sealed credential, and restores on cancel', async () => {
    installFetch({
      '/gemini/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['gemini:infer'],
        keySealed: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('gemini')} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    expect(screen.getByPlaceholderText('Gemini API Key')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Replace API Key' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Gemini API Key')).toBeNull();
    expect(screen.getByText('API Key sealed')).toBeDefined();
  });

  it('reads a static-secret `secretSealed`', async () => {
    installFetch({
      '/warp/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['warp:dispatch'],
        secretSealed: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('warp')} />);

    expect(await screen.findByText('Agent Key sealed')).toBeDefined();
  });

  it('reports Connected only once a scope is active as well', async () => {
    installFetch({
      '/gemini/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: ['gemini:infer'],
        validScopes: ['gemini:infer'],
        keySealed: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('gemini')} />);

    expect(await screen.findByText('● Connected')).toBeDefined();
  });

  it('reports Not configured when sealed with no active scope', async () => {
    installFetch({
      '/gemini/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['gemini:infer'],
        keySealed: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('gemini')} />);

    expect(await screen.findByText('○ Not configured')).toBeDefined();
  });

  it('shows the owner-approval state without telling the user to redo their work', async () => {
    installFetch({
      '/discord/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['discord:post'],
        tokenSealed: false,
        credentialPending: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('discord')} />);

    expect(await screen.findByText(/Waiting for owner approval/)).toBeDefined();
  });

  it('reports an unreachable status endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false)));

    render(<ConnectorDetail entry={entryFor('gemini')} />);

    expect(await screen.findByText(/Could not load status/)).toBeDefined();
  });
});

// ── Scope grants + disconnect ─────────────────────────────────────────────────

describe('scope grants', () => {
  it('posts the full desired scope set to the status endpoint', async () => {
    const spy = installFetch({
      '/gemini/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['gemini:infer'],
        keySealed: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('gemini')} />);
    fireEvent.click(await screen.findByRole('checkbox'));

    await waitFor(() => {
      expect(requestBody(spy, '/gemini/api/scope-manifest')).toEqual({ scopes: ['gemini:infer'] });
    });
  });

  it('disables the toggles until a credential is sealed', async () => {
    installFetch({
      '/gemini/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['gemini:infer'],
        keySealed: false,
      },
    });

    render(<ConnectorDetail entry={entryFor('gemini')} />);

    expect((await screen.findByRole('checkbox')).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Seal your API Key \(step 1\)/)).toBeDefined();
  });
});

describe('disconnect', () => {
  it('revokes a static-secret grant with DELETE on the seal route', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const spy = installFetch({
      '/warp/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: ['warp:dispatch'],
        validScopes: ['warp:dispatch'],
        secretSealed: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('warp')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Warp Cloud Agents' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('/warp/api/seal', { method: 'DELETE' });
    });
  });

  it('deletes a token-paste credential with POST on its disconnect route', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const spy = installFetch({
      '/discord/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: ['discord:post'],
        validScopes: ['discord:post'],
        tokenSealed: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('discord')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Discord' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('/discord/api/disconnect', { method: 'POST' });
    });
  });

  it('does nothing when the confirm dialog is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const spy = installFetch({
      '/discord/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: ['discord:post'],
        validScopes: ['discord:post'],
        tokenSealed: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('discord')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Discord' }));

    await waitFor(() => {
      expect(spy.mock.calls.some(([input]) => String(input) === '/discord/api/disconnect')).toBe(false);
    });
  });

  it('hides the button entirely for a connector with no disconnect route', async () => {
    installFetch({
      '/gemini/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: ['gemini:infer'],
        validScopes: ['gemini:infer'],
        keySealed: true,
      },
    });

    render(<ConnectorDetail entry={entryFor('gemini')} />);

    // Sealed, so the button would render if the card offered one — Gemini has no
    // /gemini/api/disconnect route, so offering one would only produce an error.
    expect(await screen.findByText('API Key sealed')).toBeDefined();
    expect(entryFor('gemini').disconnectRoute).toBeNull();
    expect(screen.queryByRole('button', { name: /^Disconnect/ })).toBeNull();
  });
});

// ── Dispatch ──────────────────────────────────────────────────────────────────

describe('dispatch by ingestion pattern', () => {
  it('renders a native connector with scope toggles and no credential step', async () => {
    installFetch({
      '/mcp/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: ['media:read'],
        validScopes: ['media:read'],
      },
    });

    render(<ConnectorDetail entry={entryFor('mcp')} />);

    expect(await screen.findByText('media:read')).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/Seal/)).toBeNull();
  });

  it('renders an OAuth connector through its per-id card', async () => {
    installFetch({
      '/github/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['github:read'],
        configSealed: false,
        tokenSealed: false,
      },
    });

    render(<ConnectorDetail entry={entryFor('github')} />);

    expect(await screen.findByPlaceholderText('OAuth App Client ID')).toBeDefined();
  });

  it('renders a backend-pending connector read-only, with no API calls', () => {
    const spy = installFetch({});
    const pending: ConnectorEntry = {
      ...entryFor('gemini'),
      id: 'future',
      name: 'Future Connector',
      backendPending: true,
    };

    render(<ConnectorDetail entry={pending} />);

    expect(screen.getByText('Coming soon')).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to the pending card for an OAuth connector with no card yet', () => {
    const unknownOauth: ConnectorEntry = {
      ...entryFor('github'),
      id: 'someday-oauth',
      name: 'Someday OAuth',
    };

    render(<ConnectorDetail entry={unknownOauth} />);

    // Not a silent success: this is the state the OAuthConnectorCard fast-follow
    // removes, and `connector-card-dispatch.test.ts` fails if a real registry
    // entry ever lands here.
    expect(screen.getByText('Coming soon')).toBeDefined();
  });

  it('falls back to generic copy when a paste connector declares none', async () => {
    const noCopy: ConnectorEntry = { ...entryFor('gemini'), credentialUi: null };
    installFetch({
      '/gemini/api/scope-manifest': {
        manifestAssetId: null,
        activeScopes: [],
        validScopes: ['gemini:infer'],
        keySealed: false,
      },
    });

    render(<ConnectorDetail entry={noCopy} />);

    expect(await screen.findByPlaceholderText('Google Gemini credential')).toBeDefined();
  });
});
