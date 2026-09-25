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
  process.env.NOTIFY_SERVICE_URL = 'http://notify.test';
  process.env.NOTIFY_WEBHOOK_SECRET = 'test-secret';
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NOTIFY_SERVICE_URL;
  delete process.env.NOTIFY_WEBHOOK_SECRET;
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
