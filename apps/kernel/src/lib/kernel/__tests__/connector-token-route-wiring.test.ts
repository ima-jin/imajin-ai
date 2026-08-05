/**
 * Token-route wiring tests (#1621).
 *
 * The Gemini and Anthropic token routes are pure wiring over
 * `createConnectorTokenRoutes`, so what matters is that each is bound to its OWN
 * connector: crossing the wires would seal one provider's key into the other's
 * vault field. Factory behaviour is covered in connector-token-route.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

const { capturedOpts, mockHandlers, geminiSeal, geminiSealed, anthropicSeal, anthropicSealed } = vi.hoisted(() => ({
  capturedOpts: [] as Record<string, unknown>[],
  mockHandlers: { GET: vi.fn(), POST: vi.fn(), OPTIONS: vi.fn() },
  geminiSeal: vi.fn(),
  geminiSealed: vi.fn(),
  anthropicSeal: vi.fn(),
  anthropicSealed: vi.fn(),
}));

vi.mock('../connector-token-route', () => ({
  createConnectorTokenRoutes: vi.fn((opts: Record<string, unknown>) => {
    capturedOpts.push(opts);
    return mockHandlers;
  }),
}));

vi.mock('@/src/lib/gemini/connector', () => ({
  sealApiKey: geminiSeal,
  geminiKeySealed: geminiSealed,
}));

vi.mock('@/src/lib/anthropic/connector', () => ({
  sealApiKey: anthropicSeal,
  anthropicKeySealed: anthropicSealed,
}));

// Importing evaluates each module → the factory records its options.
const geminiRoute = await import('../../../../app/gemini/api/token/route');
const anthropicRoute = await import('../../../../app/anthropic/api/token/route');

function optsFor(name: string): Record<string, unknown> {
  const found = capturedOpts.find((o) => o.name === name);
  if (!found) throw new Error(`no token route wired for ${name}`);
  return found;
}

describe('token route wiring', () => {
  it('wires the Gemini route to the Gemini connector', () => {
    const opts = optsFor('Gemini');
    expect(opts.sealApiKey).toBe(geminiSeal);
    expect(opts.keySealed).toBe(geminiSealed);
  });

  it('wires the Anthropic route to the Anthropic connector', () => {
    const opts = optsFor('Anthropic');
    expect(opts.sealApiKey).toBe(anthropicSeal);
    expect(opts.keySealed).toBe(anthropicSealed);
  });

  it('never crosses the connectors, which would seal a key into the wrong vault field', () => {
    expect(optsFor('Gemini').sealApiKey).not.toBe(anthropicSeal);
    expect(optsFor('Anthropic').sealApiKey).not.toBe(geminiSeal);
  });

  it.each([
    ['gemini', () => geminiRoute],
    ['anthropic', () => anthropicRoute],
  ])('exports the full credential lifecycle for %s', (_label, getRoute) => {
    const route = getRoute() as Record<string, unknown>;
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      expect(route[method]).toBeDefined();
    }
  });
});
