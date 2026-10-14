import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, Symbol.for('@imajin/kernel/legacy-notify-auth-warning'));
  vi.stubEnv('NOTIFY_WEBHOOK_SECRET', '');
});
afterEach(() => vi.unstubAllEnvs());

function req(secret = 'fake-rollout-key', authorization?: string) {
  const headers = new Headers({ 'x-webhook-secret': secret });
  if (authorization !== undefined) headers.set('authorization', authorization);
  return { headers };
}
it('rejects legacy auth by default when the rollout variable is unset', async () => {
  const { acceptsLegacyNotifyCredential } = await import('../legacy-auth');
  expect(acceptsLegacyNotifyCredential(req())).toBe(false);
  expect(mocks.warn).not.toHaveBeenCalled();
});
it('accepts the configured value and warns only once without logging credentials', async () => {
  vi.stubEnv('NOTIFY_WEBHOOK_SECRET', 'fake-rollout-key');
  const { acceptsLegacyNotifyCredential } = await import('../legacy-auth');
  expect(acceptsLegacyNotifyCredential(req())).toBe(true);
  expect(acceptsLegacyNotifyCredential(req())).toBe(true);
  vi.resetModules();
  const reloaded = await import('../legacy-auth');
  expect(reloaded.acceptsLegacyNotifyCredential(req())).toBe(true);
  expect(mocks.warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('fake-rollout-key');
});
it.each(['', 'short', 'fake-rollout-kex'])('rejects wrong-length or wrong-value legacy credentials: %j', async (secret) => {
  vi.stubEnv('NOTIFY_WEBHOOK_SECRET', 'fake-rollout-key');
  const { acceptsLegacyNotifyCredential } = await import('../legacy-auth');
  expect(acceptsLegacyNotifyCredential(req(secret))).toBe(false);
  expect(mocks.warn).not.toHaveBeenCalled();
});
it.each(['Bearer fake-invalid-token', 'Basic fake-other-credential', ''])(
  'never accepts legacy when any Authorization was supplied: %j', async (authorization) => {
    vi.stubEnv('NOTIFY_WEBHOOK_SECRET', 'fake-rollout-key');
    const { acceptsLegacyNotifyCredential } = await import('../legacy-auth');
    expect(acceptsLegacyNotifyCredential(req('fake-rollout-key', authorization))).toBe(false);
  },
);
