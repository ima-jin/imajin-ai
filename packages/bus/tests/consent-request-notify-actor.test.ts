/**
 * `sendConsentRequestNotification` must carry the `{did, appDid}` pair (#2366).
 *
 * Before this fix the notification only carried `requesterDid`. On the
 * app-token lane (#1926) a delegate acts with `azp` = itself and `sub` = the
 * principal, so a projection request resolved its requester to the owner and
 * the alert named the owner as their own requester — the acting app never
 * appeared. These tests pin the wire shape the notify template renders from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { mockSql, mockBegin } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockBegin: vi.fn(),
}));
vi.mock('@imajin/db', () => ({ getClient: () => ({ begin: mockBegin }) }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { sendConsentRequestNotification } from '../src/reactors/consent-request-notify';
import type { BrokerRequest } from '../src/types';

const OWNER = 'did:imajin:88kPzzzzzzzzzzzzzzzzzzzzzzzzzzzzNWXU';
const ACTING_APP = 'did:imajin:ADEKzzzzzzzzzzzzzzzzzzzzzzzzzzzzn54k';

function makeRequest(overrides: Partial<BrokerRequest> = {}): BrokerRequest {
  return {
    type: 'document.project',
    requester: OWNER,
    subject: OWNER,
    fields: ['moonshot:infer'],
    purpose: 'document.projection',
    scope: 'media',
    ...overrides,
  };
}

/** The `data` object POSTed to `/api/send` for the most recent call. */
function sentData(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return (JSON.parse(init.body) as { data: Record<string, unknown> }).data;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NOTIFY_SERVICE_URL', 'http://notify.test');
  mockSql.mockImplementation((strings: TemplateStringsArray) =>
    Promise.resolve(strings.join('').includes('pg_try_advisory_xact_lock') ? [{ acquired: true }] : []));
  mockBegin.mockImplementation(async (callback: (tx: typeof mockSql) => Promise<void>) => callback(mockSql));
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('sendConsentRequestNotification — acting delegate (#2366)', () => {
  it('sends the principal as `did` and the delegate as `appDid`', async () => {
    await sendConsentRequestNotification(makeRequest({ appDid: ACTING_APP }), 'no_consent');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentData(fetchMock)).toMatchObject({
      requesterDid: OWNER,
      did: OWNER,
      appDid: ACTING_APP,
      purpose: 'document.projection',
      fields: ['moonshot:infer'],
    });
  });

  it('omits `appDid` entirely for a true first-party request', async () => {
    await sendConsentRequestNotification(makeRequest(), 'no_consent');

    const data = sentData(fetchMock);
    expect(data).toMatchObject({ requesterDid: OWNER, did: OWNER });
    expect(Object.keys(data)).not.toContain('appDid');
  });

  it('still sends nothing for a non-no_consent rejection', async () => {
    await sendConsentRequestNotification(makeRequest({ appDid: ACTING_APP }), 'purpose_mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still sends nothing for preview or shadow requests', async () => {
    await sendConsentRequestNotification(makeRequest({ appDid: ACTING_APP, preview: true }), 'no_consent');
    await sendConsentRequestNotification(makeRequest({ appDid: ACTING_APP, mode: 'shadow' }), 'no_consent');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pending consent request dedupe (#3081)', () => {
  it('sends one notification for repeated no_consent while the persisted alert is pending', async () => {
    await sendConsentRequestNotification(makeRequest(), 'no_consent');
    mockSql.mockResolvedValueOnce([{ acquired: true }]).mockResolvedValueOnce([{ id: 'ntf_pending' }]);
    await sendConsentRequestNotification(makeRequest(), 'no_consent');
    expect(fetchMock).toHaveBeenCalledOnce();
    const query = mockSql.mock.calls[1];
    expect(query[0].join('')).toContain('read = false');
    expect(query[0].join('')).toContain("(data->>'expiresAt')::timestamptz > NOW()");
    expect(query.slice(1)).toEqual([OWNER, OWNER, 'document.projection', '["moonshot:infer"]', '["moonshot:infer"]']);
  });

  it('canonicalizes fields as a set, sharing a lock across order and duplicates', async () => {
    await sendConsentRequestNotification(makeRequest({ fields: ['phone', 'email', 'email'] }), 'no_consent');
    await sendConsentRequestNotification(makeRequest({ fields: ['email', 'phone'] }), 'no_consent');
    expect(mockSql.mock.calls[0][1]).toBe(mockSql.mock.calls[2][1]);
    expect(mockSql.mock.calls[1].at(-1)).toBe('["email","phone"]');
    expect(mockSql.mock.calls[1][0].join('')).toContain("data->'fields' @>");
    expect(mockSql.mock.calls[1][0].join('')).toContain("data->'fields' <@");
  });

  it.each([
    { requester: 'did:imajin:other' }, { subject: 'did:imajin:other' },
    { purpose: 'another.purpose' }, { fields: ['different'] },
  ])('uses a different pending key for a changed tuple %j', async overrides => {
    await sendConsentRequestNotification(makeRequest(), 'no_consent');
    await sendConsentRequestNotification(makeRequest(overrides), 'no_consent');
    expect(mockSql.mock.calls[0][1]).not.toBe(mockSql.mock.calls[2][1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops concurrent loads when another worker holds the tuple lock', async () => {
    mockSql.mockResolvedValueOnce([{ acquired: false }]);
    await sendConsentRequestNotification(makeRequest(), 'no_consent');
    expect(mockSql).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('notifies only once while simultaneous loads race an in-flight delivery', async () => {
    let locked = false;
    mockBegin.mockImplementation(async (callback: (tx: typeof mockSql) => Promise<void>) => {
      let ownsLock = false;
      try {
        return await callback(vi.fn(async (strings: TemplateStringsArray) => {
          if (!strings.join('').includes('pg_try_advisory_xact_lock')) return [];
          const acquired = !locked;
          ownsLock = acquired;
          locked = true;
          return [{ acquired }];
        }));
      } finally {
        if (ownsLock) locked = false;
      }
    });
    let completeDelivery!: () => void;
    const delivery = new Promise<void>(resolve => { completeDelivery = resolve; });
    fetchMock.mockImplementation(async () => {
      await delivery;
      return { ok: true };
    });
    const first = sendConsentRequestNotification(makeRequest(), 'no_consent');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await Promise.all(Array.from({ length: 5 }, () => sendConsentRequestNotification(makeRequest(), 'no_consent')));
    completeDelivery();
    await first;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { read: true, expired: false },
    { read: false, expired: true },
    { read: false, expired: false },
    { read: false, expired: null },
  ])('suppresses only undecided, unexpired alerts (%j)', async ({ read, expired }) => {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join('');
      if (query.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
      // The existing bell uses read for decisions; absent expiry stays pending.
      expect(query).toContain('read = false');
      expect(query).toContain("data->>'expiresAt' IS NULL");
      expect(query).toContain("(data->>'expiresAt')::timestamptz > NOW()");
      return !read && !expired ? [{ id: 'ntf_existing' }] : [];
    });
    await sendConsentRequestNotification(makeRequest(), 'no_consent');
    expect(fetchMock).toHaveBeenCalledTimes(!read && !expired ? 0 : 1);
  });

  it('skips delivery on a dedupe database error rather than stacking unguarded alerts', async () => {
    mockBegin.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(sendConsentRequestNotification(makeRequest(), 'no_consent')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['http', 'network'])('allows retry after a %s delivery failure', async failure => {
    if (failure === 'http') fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    else fetchMock.mockRejectedValueOnce(new Error('unavailable'));
    await sendConsentRequestNotification(makeRequest(), 'no_consent');
    await sendConsentRequestNotification(makeRequest(), 'no_consent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does no database work when notify is not configured', async () => {
    vi.stubEnv('NOTIFY_SERVICE_URL', '');
    await sendConsentRequestNotification(makeRequest(), 'no_consent');
    expect(mockBegin).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

vi.mock('@imajin/auth', () => ({ getVaultInternalApiKey: () => 'fake-vault-internal-key' }));
