/**
 * Disconnect-route wiring tests (#1720).
 *
 * The Gemini, Anthropic, and GCP disconnect routes are pure wiring over
 * `createConnectorTokenDisconnectRoute`, so what matters is that each is bound
 * to its OWN connector's `revokeApiKey` — crossing the wires would revoke one
 * provider's key from a request meant for another. Factory behaviour is
 * covered in connector-token-disconnect-route.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

const { capturedOpts, mockHandlers, geminiRevoke, anthropicRevoke, gcpRevoke } = vi.hoisted(() => ({
  capturedOpts: [] as Record<string, unknown>[],
  mockHandlers: { POST: vi.fn(), OPTIONS: vi.fn() },
  geminiRevoke: vi.fn(),
  anthropicRevoke: vi.fn(),
  gcpRevoke: vi.fn(),
}));

vi.mock('../connector-token-route', () => ({
  createConnectorTokenDisconnectRoute: vi.fn((opts: Record<string, unknown>) => {
    capturedOpts.push(opts);
    return mockHandlers;
  }),
}));

vi.mock('@/src/lib/gemini/connector', () => ({ revokeApiKey: geminiRevoke }));
vi.mock('@/src/lib/anthropic/connector', () => ({ revokeApiKey: anthropicRevoke }));
vi.mock('@/src/lib/gcp/connector', () => ({ revokeApiKey: gcpRevoke }));

// Importing evaluates each module → the factory records its options.
const geminiRoute = await import('../../../../app/gemini/api/disconnect/route');
const anthropicRoute = await import('../../../../app/anthropic/api/disconnect/route');
const gcpRoute = await import('../../../../app/gcp/api/disconnect/route');

function optsFor(name: string): Record<string, unknown> {
  const found = capturedOpts.find((o) => o.name === name);
  if (!found) throw new Error(`no disconnect route wired for ${name}`);
  return found;
}

describe('token disconnect route wiring', () => {
  it('wires the Gemini disconnect route to the Gemini connector', () => {
    expect(optsFor('Gemini').revokeApiKey).toBe(geminiRevoke);
  });

  it('wires the Anthropic disconnect route to the Anthropic connector', () => {
    expect(optsFor('Anthropic').revokeApiKey).toBe(anthropicRevoke);
  });

  it('wires the GCP disconnect route to the GCP connector', () => {
    expect(optsFor('Google Cloud').revokeApiKey).toBe(gcpRevoke);
  });

  it("never crosses the connectors, which would revoke the wrong provider's grant", () => {
    expect(optsFor('Gemini').revokeApiKey).not.toBe(anthropicRevoke);
    expect(optsFor('Gemini').revokeApiKey).not.toBe(gcpRevoke);
    expect(optsFor('Anthropic').revokeApiKey).not.toBe(gcpRevoke);
  });

  it.each([
    ['gemini', () => geminiRoute],
    ['anthropic', () => anthropicRoute],
    ['gcp', () => gcpRoute],
  ])('exports POST + OPTIONS for %s', (_label, getRoute) => {
    const route = getRoute() as Record<string, unknown>;
    for (const method of ['POST', 'OPTIONS']) {
      expect(route[method]).toBeDefined();
    }
  });
});
