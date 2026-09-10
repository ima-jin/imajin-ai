/**
 * Coverage for CoffeePage's inline seller-connected check (#2137).
 *
 * The stale `http://localhost:3004` PAY_SERVICE_URL fallback predated the
 * kernel consolidation (pay now lives under the kernel at `:3000/pay`) and
 * pointed at nothing real. These tests exercise the real page function
 * end-to-end (same approach as apps/events' event-edit-page.test.tsx) to pin
 * the corrected fallback and each outcome of the inline try/catch: charges
 * enabled, charges disabled, and a network failure that must leave the
 * default `sellerConnected = true` untouched so tips are never blocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  notFoundMock: vi.fn(),
  fetchMock: vi.fn(),
  tipFormMock: vi.fn(() => null),
}));

vi.mock('next/navigation', () => ({
  notFound: mocks.notFoundMock,
}));

vi.mock('@/db', () => ({
  db: { query: { coffeePages: { findFirst: mocks.findFirstMock } } },
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: vi.fn((svc: string) => `https://${svc}.test`),
}));

vi.mock('../tip-form', () => ({
  default: mocks.tipFormMock,
}));

import CoffeePage from '../page';

/** Recursively search a React element tree (as returned, unrendered) for an element whose `type` matches. */
function findElementByType(node: unknown, type: unknown): ReactElement<any> | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as ReactElement<any>;
  if (el.type === type) return el;
  const children = (el.props as { children?: unknown })?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElementByType(child, type);
      if (found) return found;
    }
  } else if (children) {
    return findElementByType(children, type);
  }
  return null;
}

const PAGE = {
  handle: 'creator',
  isPublic: true,
  did: 'did:imajin:creator',
  title: 'Creator Page',
  bio: null,
  avatar: null,
  theme: {},
  presets: [300, 500, 1000],
  fundDirections: null,
  allowCustomAmount: true,
  allowMessages: true,
  paymentMethods: {},
};

const PROPS = { params: Promise.resolve({ handle: 'creator' }) };

let originalPayServiceUrl: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalPayServiceUrl = process.env.PAY_SERVICE_URL;
  delete process.env.PAY_SERVICE_URL;
  mocks.findFirstMock.mockResolvedValue(PAGE);
  vi.stubGlobal('fetch', mocks.fetchMock);
});

afterEach(() => {
  if (originalPayServiceUrl === undefined) delete process.env.PAY_SERVICE_URL;
  else process.env.PAY_SERVICE_URL = originalPayServiceUrl;
  vi.unstubAllGlobals();
});

describe('CoffeePage — seller-connected check (#2137: kernel-prefixed :3000/pay fallback)', () => {
  it('uses the corrected http://localhost:3000/pay fallback (not the stale :3004 one) and passes sellerConnected=true through to TipForm', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ chargesEnabled: true }) });

    const element = await CoffeePage(PROPS as any);

    expect(mocks.fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/pay/api/connect/check?did=${encodeURIComponent(PAGE.did)}`,
      { cache: 'no-store' },
    );
    const [url] = mocks.fetchMock.mock.calls[0];
    expect(url).not.toContain('localhost:3004');

    const tipForm = findElementByType(element, mocks.tipFormMock);
    expect(tipForm).not.toBeNull();
    expect(tipForm!.props.sellerConnected).toBe(true);
  });

  it('passes sellerConnected=false through to TipForm when charges are explicitly disabled', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ chargesEnabled: false }) });

    const element = await CoffeePage(PROPS as any);

    const tipForm = findElementByType(element, mocks.tipFormMock);
    expect(tipForm!.props.sellerConnected).toBe(false);
  });

  it('keeps the default sellerConnected=true when the check throws (never blocks tips on error)', async () => {
    mocks.fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const element = await CoffeePage(PROPS as any);

    const tipForm = findElementByType(element, mocks.tipFormMock);
    expect(tipForm!.props.sellerConnected).toBe(true);
  });

  it('keeps the default sellerConnected=true when the check responds non-OK', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const element = await CoffeePage(PROPS as any);

    const tipForm = findElementByType(element, mocks.tipFormMock);
    expect(tipForm!.props.sellerConnected).toBe(true);
  });

  it('honors an explicit PAY_SERVICE_URL override instead of the fallback', async () => {
    process.env.PAY_SERVICE_URL = 'https://kernel.example.com/pay';
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ chargesEnabled: true }) });

    await CoffeePage(PROPS as any);

    expect(mocks.fetchMock).toHaveBeenCalledWith(
      `https://kernel.example.com/pay/api/connect/check?did=${encodeURIComponent(PAGE.did)}`,
      { cache: 'no-store' },
    );
  });
});
