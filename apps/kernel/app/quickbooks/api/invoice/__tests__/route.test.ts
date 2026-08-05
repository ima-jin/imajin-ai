import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRequireAppAuth,
  mockCreateInvoice,
  mockBuildSaleFairManifest,
  mockAttachFairManifestToLot,
} = vi.hoisted(() => ({
  mockRequireAppAuth: vi.fn(),
  mockCreateInvoice: vi.fn(),
  mockBuildSaleFairManifest: vi.fn(),
  mockAttachFairManifestToLot: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: mockRequireAppAuth,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://agri.example' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/quickbooks/connector', () => ({
  createInvoice: mockCreateInvoice,
}));

vi.mock('@/src/lib/quickbooks/settlement', () => ({
  buildSaleFairManifest: mockBuildSaleFairManifest,
  attachFairManifestToLot: mockAttachFairManifestToLot,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST, OPTIONS } from '../route';
import { createInvoice } from '@/src/lib/quickbooks/connector';

const USER_DID = 'did:imajin:supplier';
const APP_DID = 'did:imajin:agrifortress-app';
const SECRET = 'qb-access-token-SUPER-SECRET';

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(body: unknown, opts: { invalidJson?: boolean } = {}): RouteRequest {
  return {
    headers: new Headers(),
    json: async () => {
      if (opts.invalidJson) {
        throw new Error('invalid json');
      }
      return body;
    },
  } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAppAuth.mockResolvedValue({
    appAuth: {
      appDid: APP_DID,
      userDid: USER_DID,
      scopes: ['quickbooks:write'],
      attestationId: 'att_app',
    },
  });
  mockCreateInvoice.mockResolvedValue({
    id: 'invoice_55',
    docNumber: '1042',
    customerName: 'David',
    totalAmount: 42,
    balance: 42,
    currency: 'CAD',
    txnDate: '2026-08-05',
    correlationId: 'lot_eggs_1',
  });
  mockBuildSaleFairManifest.mockReturnValue({ fair: true });
  mockAttachFairManifestToLot.mockResolvedValue(undefined);
});

describe('POST /quickbooks/api/invoice (#1540)', () => {
  it('requires the quickbooks:write app scope', async () => {
    await POST(makeReq({ correlationId: 'lot_eggs_1', customerRef: '12', lines: [{ amount: 42, itemRef: '7' }] }));

    expect(mockRequireAppAuth).toHaveBeenCalledWith(
      expect.anything(),
      { scope: 'quickbooks:write' },
    );
  });

  it('creates the invoice using the delegating user DID, not the app DID or body DID', async () => {
    await POST(
      makeReq({
        ownerDid: 'did:imajin:malicious',
        correlationId: 'lot_eggs_1',
        customerRef: '12',
        lines: [{ amount: 42, itemRef: '7' }],
      }),
    );

    expect(createInvoice).toHaveBeenCalledWith(
      USER_DID,
      { correlationId: 'lot_eggs_1', customerRef: '12', lines: [{ amount: 42, itemRef: '7' }] },
    );
    expect(mockBuildSaleFairManifest).toHaveBeenCalledWith(USER_DID, 'lot_eggs_1');
    expect(mockAttachFairManifestToLot).toHaveBeenCalledWith('lot_eggs_1', { fair: true }, undefined);
  });

  it('returns invoice output without credential material crossing back to the app', async () => {
    const res = await POST(
      makeReq({
        correlationId: 'lot_eggs_1',
        customerRef: '12',
        lines: [{ amount: 42, itemRef: '7' }],
        token: SECRET,
      }),
    );

    expect(res.status).toBe(201);
    const bodyText = JSON.stringify(await res.json());
    expect(bodyText).toContain('invoice_55');
    expect(bodyText).not.toContain(SECRET);
    expect(bodyText).not.toContain('accessToken');
    expect(bodyText).not.toContain('refreshToken');
    expect(bodyText).not.toContain('clientSecret');
  });

  it('returns a generic error when connector invocation fails with a secret-bearing error', async () => {
    mockCreateInvoice.mockRejectedValueOnce(new Error(`upstream failed with ${SECRET}`));

    const res = await POST(makeReq({ correlationId: 'lot_eggs_1', customerRef: '12', lines: [{ amount: 42, itemRef: '7' }] }));

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
  });

  it('rejects service tokens with no delegating user', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: {
        appDid: APP_DID,
        userDid: '',
        scopes: ['quickbooks:write'],
        attestationId: '',
        isServiceToken: true,
      },
    });

    const res = await POST(makeReq({ correlationId: 'lot_eggs_1', customerRef: '12', lines: [{ amount: 42, itemRef: '7' }] }));

    expect(res.status).toBe(403);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq({}));
    expect(res.status).toBe(204);
  });
});
