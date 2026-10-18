import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), owner: vi.fn(), ready: vi.fn() }));
vi.mock('../store', () => ({ listSenderConfigs: mocks.list, resolveMailOwner: mocks.owner }));
vi.mock('../readiness', () => ({ isDomainMailReady: mocks.ready }));
import { resolveSender } from '../resolver';
import { DEFAULT_SENDERS, MAIL_PURPOSES, type SenderConfig } from '../types';

const owner = 'did:imajin:owner';
const app = 'did:imajin:app';
const base: SenderConfig = { ownerDid: owner, appDid: '', purpose: 'signin', domain: 'owner.com', localPart: 'signin', displayName: 'Owner', replyTo: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.owner.mockImplementation(async (ownerDid?: string) => ownerDid);
  mocks.list.mockResolvedValue([]);
  mocks.ready.mockResolvedValue(false);
});
describe('mail sender resolution', () => {
  it.each(MAIL_PURPOSES)('uses immutable %s default with no owner', async purpose => {
    expect(await resolveSender({ purpose })).toEqual({ from: DEFAULT_SENDERS[purpose], source: 'default' });
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('proves app → owner → default precedence as domain readiness changes', async () => {
    mocks.list.mockResolvedValue([base, { ...base, appDid: app, domain: 'app.com', displayName: 'App', replyTo: 'reply@app.com' }]);
    const options = { purpose: 'signin' as const, ownerDid: owner, appDid: app };
    expect((await resolveSender(options)).source).toBe('default');
    mocks.ready.mockImplementation(async (_owner: string, domain: string) => domain === 'owner.com');
    expect(await resolveSender(options)).toEqual({ from: 'Owner <signin@owner.com>', source: 'owner' });
    mocks.ready.mockResolvedValue(true);
    expect(await resolveSender(options)).toEqual({ from: 'App <signin@app.com>', replyTo: 'reply@app.com', source: 'app' });
    expect(mocks.ready).toHaveBeenCalledWith(owner, 'app.com');
  });
  it('ignores other owners, purposes and app identities even if readiness says true', async () => {
    mocks.ready.mockResolvedValue(true);
    mocks.list.mockResolvedValue([
      { ...base, ownerDid: 'did:imajin:other' }, { ...base, purpose: 'receipts' }, { ...base, appDid: 'did:imajin:other' },
    ]);
    expect((await resolveSender({ purpose: 'signin', ownerDid: owner, appDid: app })).source).toBe('default');
  });
  it('derives owner when only app identity supplied', async () => {
    mocks.owner.mockResolvedValue(owner);
    mocks.list.mockResolvedValue([base]);
    mocks.ready.mockResolvedValue(true);
    expect((await resolveSender({ purpose: 'signin', appDid: app })).source).toBe('owner');
    expect(mocks.list).toHaveBeenCalledWith(owner);
  });
  it('refuses malformed stored config before checking domain readiness', async () => {
    mocks.list.mockResolvedValue([{ ...base, displayName: 'Bad\r\nBcc: leak' }]);
    expect((await resolveSender({ purpose: 'signin', ownerDid: owner })).source).toBe('default');
    expect(mocks.ready).not.toHaveBeenCalled();
  });
  it('does not mask failed registry ownership checks or unsupported runtime purpose', async () => {
    mocks.owner.mockRejectedValue(new Error('owner mismatch'));
    await expect(resolveSender({ purpose: 'signin', ownerDid: owner, appDid: app })).rejects.toThrow('mismatch');
    await expect(resolveSender({ purpose: 'arbitrary' as never })).rejects.toThrow('purpose');
  });
  it('falls back safely when readiness verification is unavailable', async () => {
    mocks.list.mockResolvedValue([base]);
    mocks.ready.mockRejectedValue(new Error('verification unavailable'));
    expect((await resolveSender({ purpose: 'signin', ownerDid: owner })).source).toBe('default');
  });
});
