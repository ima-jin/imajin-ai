/**
 * Tests for sendNewDeviceAlert (#306).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const selectWhere = vi.fn();
  const selectLimit = vi.fn(() => selectWhere());
  const selectFrom = vi.fn(() => ({ where: () => ({ limit: selectLimit }) }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const sendEmailMock = vi.fn().mockResolvedValue({ success: true });

  return { select, selectFrom, selectLimit, selectWhere, sendEmailMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.select },
  credentials: { did: 'did', type: 'type', value: 'value' },
}));

vi.mock('drizzle-orm', () => ({ and: (...args: unknown[]) => args, eq: (...args: unknown[]) => args }));

vi.mock('@imajin/config', () => ({
  buildPublicUrlAbsolute: (name: string) => `https://jin.imajin.ai/${name}`,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/email', () => ({
  sendEmail: mocks.sendEmailMock,
  emailWrapper: (content: string) => `<html>${content}</html>`,
}));

import { sendNewDeviceAlert } from '../send-new-device-alert';

const DID = 'did:imajin:test-user';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sendNewDeviceAlert (#306)', () => {
  it('sends exactly one email to the DID\'s registered address', async () => {
    mocks.selectWhere.mockResolvedValue([{ value: 'user@example.com' }]);

    await sendNewDeviceAlert({ did: DID, platform: 'macOS', browser: 'Chrome' });

    expect(mocks.sendEmailMock).toHaveBeenCalledOnce();
    const call = mocks.sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe('user@example.com');
    expect(call.subject).toBe('New login to your Imajin account');
    expect(call.html).toContain('Chrome');
    expect(call.html).toContain('macOS');
    expect(call.html).toContain('https://jin.imajin.ai/profile/keys');
    expect(call.text).toContain('Chrome');
  });

  it('includes the location line when city/country are known', async () => {
    mocks.selectWhere.mockResolvedValue([{ value: 'user@example.com' }]);

    await sendNewDeviceAlert({ did: DID, platform: 'macOS', browser: 'Chrome', city: 'Toronto', country: 'Canada' });

    const call = mocks.sendEmailMock.mock.calls[0][0];
    expect(call.html).toContain('Toronto, Canada');
    expect(call.text).toContain('Toronto, Canada');
  });

  it('omits the location line when no geo data is available', async () => {
    mocks.selectWhere.mockResolvedValue([{ value: 'user@example.com' }]);

    await sendNewDeviceAlert({ did: DID, platform: 'macOS', browser: 'Chrome' });

    const call = mocks.sendEmailMock.mock.calls[0][0];
    expect(call.html).not.toContain('undefined');
    expect(call.html).not.toContain('null');
  });

  it('does not send when the DID has no email credential on file', async () => {
    mocks.selectWhere.mockResolvedValue([]);

    await sendNewDeviceAlert({ did: DID, platform: 'macOS', browser: 'Chrome' });

    expect(mocks.sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not throw when the email provider rejects', async () => {
    mocks.selectWhere.mockResolvedValue([{ value: 'user@example.com' }]);
    mocks.sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));

    await expect(
      sendNewDeviceAlert({ did: DID, platform: 'macOS', browser: 'Chrome' })
    ).resolves.toBeUndefined();
  });
});
