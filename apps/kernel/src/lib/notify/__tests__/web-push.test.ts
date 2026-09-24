/**
 * Tests for the web-push fan-out (#2291): VAPID keys gate the whole leg,
 * only active (non-revoked) subscriptions for the given operator are sent
 * to, a gone (404/410) subscription is revoked rather than retried, and
 * every other failure mode degrades silently (never throws).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendNotification, mockSetVapidDetails, mockGetVapidKeys, mockResolveVapidSubject, mockSelectWhere, mockUpdateWhere } = vi.hoisted(() => ({
  mockSendNotification: vi.fn(),
  mockSetVapidDetails: vi.fn(),
  mockGetVapidKeys: vi.fn(),
  mockResolveVapidSubject: vi.fn(() => 'mailto:ops@example.com'),
  mockSelectWhere: vi.fn(),
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('web-push', () => ({
  default: {
    sendNotification: mockSendNotification,
    setVapidDetails: mockSetVapidDetails,
  },
}));

vi.mock('../vapid', () => ({
  getVapidKeys: mockGetVapidKeys,
  resolveVapidSubject: mockResolveVapidSubject,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: mockSelectWhere }) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) })),
  },
  pushSubscriptions: { id: 'id', operatorDid: 'operator_did', revokedAt: 'revoked_at', endpoint: 'endpoint' },
}));

import { pushWebNotificationToOperator } from '../web-push';

const OPERATOR_DID = 'did:imajin:ryan-operator';
const PAYLOAD = { title: 'Operator approval needed — system-agent:restart', body: 'Restart the gateway.', url: '/jin?proposalId=opap_1' };

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'psub_1',
    operatorDid: OPERATOR_DID,
    endpoint: 'https://push.example.com/abc',
    p256dh: 'p256dh-key',
    auth: 'auth-key',
    userAgent: null,
    revokedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVapidKeys.mockResolvedValue({ publicKey: 'pub', privateKey: 'priv' });
  mockResolveVapidSubject.mockReturnValue('mailto:ops@example.com');
  mockSelectWhere.mockResolvedValue([]);
  mockSendNotification.mockResolvedValue(undefined);
});

describe('pushWebNotificationToOperator', () => {
  it('no-ops when VAPID keys are not yet provisioned', async () => {
    mockGetVapidKeys.mockResolvedValue(null);

    await pushWebNotificationToOperator(OPERATOR_DID, PAYLOAD);

    expect(mockSelectWhere).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('no-ops when the operator has no active subscriptions', async () => {
    mockSelectWhere.mockResolvedValue([]);

    await pushWebNotificationToOperator(OPERATOR_DID, PAYLOAD);

    expect(mockSetVapidDetails).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('sends the payload to every active subscription, configuring VAPID details first', async () => {
    mockSelectWhere.mockResolvedValue([subscription({ id: 'psub_1' }), subscription({ id: 'psub_2', endpoint: 'https://push.example.com/def' })]);

    await pushWebNotificationToOperator(OPERATOR_DID, PAYLOAD);

    expect(mockSetVapidDetails).toHaveBeenCalledWith('mailto:ops@example.com', 'pub', 'priv');
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    expect(mockSendNotification).toHaveBeenCalledWith(
      { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p256dh-key', auth: 'auth-key' } },
      JSON.stringify(PAYLOAD),
    );
  });

  it.each([404, 410])('revokes a subscription the push service reports gone (status %i) rather than retrying it', async (statusCode) => {
    mockSelectWhere.mockResolvedValue([subscription({ id: 'psub_gone' })]);
    mockSendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode }));

    await pushWebNotificationToOperator(OPERATOR_DID, PAYLOAD);

    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('does not revoke a subscription on a transient send error (e.g. 500)', async () => {
    mockSelectWhere.mockResolvedValue([subscription({ id: 'psub_1' })]);
    mockSendNotification.mockRejectedValueOnce(Object.assign(new Error('server error'), { statusCode: 500 }));

    await pushWebNotificationToOperator(OPERATOR_DID, PAYLOAD);

    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('never throws — a totally unexpected failure (e.g. the subscriptions query itself) degrades silently', async () => {
    mockSelectWhere.mockRejectedValue(new Error('db unavailable'));

    await expect(pushWebNotificationToOperator(OPERATOR_DID, PAYLOAD)).resolves.toBeUndefined();
  });

  it('sends independently to each subscription — one failing does not stop the others', async () => {
    mockSelectWhere.mockResolvedValue([subscription({ id: 'psub_bad' }), subscription({ id: 'psub_good', endpoint: 'https://push.example.com/good' })]);
    mockSendNotification.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    await pushWebNotificationToOperator(OPERATOR_DID, PAYLOAD);

    expect(mockSendNotification).toHaveBeenCalledTimes(2);
  });
});
