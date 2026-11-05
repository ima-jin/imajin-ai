import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  register: vi.fn(), select: vi.fn(), update: vi.fn(), template: vi.fn(), push: vi.fn(), email: vi.fn(),
}));
vi.mock('@imajin/bus', () => ({ registerConsentNotificationPreparer: m.register }));
vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: m.select }) }) }),
    update: () => ({ set: (value: unknown) => ({ where: () => m.update(value) }) }),
  },
  notifications: { id: 'id' }, preferences: { did: 'did', scope: 'scope' },
  profiles: { did: 'did', contactEmail: 'email' }, identities: { id: 'id', contactEmail: 'email' },
  credentials: { did: 'did', type: 'type', value: 'email' },
}));
vi.mock('../template-store', () => ({ getTemplate: m.template }));
vi.mock('../ws-push', () => ({ buildNotificationFrame: (frame: unknown) => frame, pushNotificationToDid: m.push }));
vi.mock('@/src/lib/mail/send', () => ({ sendKernelEmail: m.email }));
import { prepareConsentNotification, registerConsentNotifications } from '../consent-notifications';

function input(to = 'did:imajin:person') {
  return { to, scope: 'broker:consent-request', urgency: 'urgent' as const,
    data: { did: to, appDid: 'did:imajin:app', purpose: 'data', fields: ['field'] } };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.select.mockReset().mockResolvedValue([]);
  m.template.mockReset().mockResolvedValue({ title: () => 'Consent', body: () => 'Review' });
  m.push.mockReset().mockResolvedValue(true);
  m.email.mockReset().mockResolvedValue({ success: true });
  m.update.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No self HTTP'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });
it.each(['did:imajin:person', 'did:imajin:org'])('persists for %s using exactly the lock-owning transaction, with no delivery until commit', async did => {
  const prepared = await prepareConsentNotification(input(did));
  const unsafe = vi.fn().mockResolvedValue([]);
  expect(m.push).not.toHaveBeenCalled();
  await prepared.persist({ unsafe } as never);
  const [query, values] = unsafe.mock.calls[0];
  expect(query).toContain('INSERT INTO notify.notifications');
  expect(values[1]).toBe(did);
  expect(JSON.parse(values[6])).toMatchObject({ did, appDid: 'did:imajin:app' });
  expect(m.push).not.toHaveBeenCalled();
  await prepared.deliver();
  expect(m.push).toHaveBeenCalledWith(did, expect.objectContaining({ scope: input().scope, title: 'Consent' }));
  expect(m.update).toHaveBeenCalledWith({ channelsSent: ['inapp', 'ws'] });
  expect(fetch).not.toHaveBeenCalled();
});
it('respects disabled in-app and email preferences without skipping persistence', async () => {
  m.select.mockResolvedValue([{ email: false, inapp: false }]);
  const prepared = await prepareConsentNotification(input());
  await prepared.deliver();
  expect(m.push).not.toHaveBeenCalled();
  expect(m.email).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
});
it('records in-app but not WS when no socket received delivery', async () => {
  m.push.mockResolvedValue(false);
  const prepared = await prepareConsentNotification(input());
  await prepared.deliver();
  expect(m.update).toHaveBeenCalledWith({ channelsSent: ['inapp'] });
});
it('uses a safe fallback when the template is unavailable', async () => {
  m.template.mockResolvedValue(undefined);
  const prepared = await prepareConsentNotification(input());
  await prepared.deliver();
  expect(m.push).toHaveBeenCalledWith(input().to, expect.objectContaining({ title: input().scope }));
});
it.each(['profile', 'identity', 'credential', 'missing'])('resolves configured template email from %s outside the transaction', async source => {
  m.template.mockResolvedValue({ title: () => 'Consent', body: () => 'Review',
    email: { subject: () => 'Subject', html: () => '<p>Review</p>' } });
  m.select.mockResolvedValueOnce([]); // preference
  for (const candidate of ['profile', 'identity', 'credential']) {
    m.select.mockResolvedValueOnce(candidate === source ? [{ email: 'recipient@example.test' }] : []);
    if (candidate === source) break;
  }
  const prepared = await prepareConsentNotification(input());
  expect(m.email).not.toHaveBeenCalled();
  await prepared.deliver();
  expect(m.email).toHaveBeenCalledTimes(source === 'missing' ? 0 : 1);
  if (source !== 'missing') expect(m.update).toHaveBeenCalledWith({ channelsSent: ['inapp', 'ws', 'email'] });
});
it('does not record email success when the provider refuses', async () => {
  m.template.mockResolvedValue({ title: () => 'Consent', body: () => '',
    email: { subject: () => 'Subject', html: () => '<p>Review</p>' } });
  m.select.mockResolvedValueOnce([]).mockResolvedValueOnce([{ email: 'recipient@example.test' }]);
  m.email.mockResolvedValue({ success: false });
  const prepared = await prepareConsentNotification(input());
  await prepared.deliver();
  expect(m.update).toHaveBeenCalledWith({ channelsSent: ['inapp', 'ws'] });
});
it.each([{ ...input(), scope: 'arbitrary' }, input('not-a-did')])('rejects invalid internal notification target/scope', async notification => {
  await expect(prepareConsentNotification(notification)).rejects.toThrow('Invalid internal consent notification');
  expect(m.select).not.toHaveBeenCalled();
});
it('registers the kernel preparer explicitly', () => {
  registerConsentNotifications();
  expect(m.register).toHaveBeenCalledWith(prepareConsentNotification);
});
