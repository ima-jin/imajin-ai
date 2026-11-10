import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALPHA_INTENTS, ALPHA_LIMITS, ALPHA_RATE_WINDOW_MS } from '@/src/lib/alpha/contract';

const mocks = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock('@/src/lib/alpha/store', () => ({ storeAlphaSubmission: mocks.store }));
import * as route from '../route';

const valid = { name: 'Test Person', email: 'person@example.com', company: 'Example', intent: 'tester', purpose: 'Help people book travel.' };
let ip = 0;
const request = (body: unknown = valid, address = `192.0.2.${++ip}`) => new Request('http://localhost/api/alpha', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': address }, body: JSON.stringify(body),
});
beforeEach(() => { vi.clearAllMocks(); mocks.store.mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('public alpha intake', () => {
  it('accepts a native form POST before hydration and redirects without personal data in the URL', async () => {
    const response = await route.POST(new Request('http://localhost/api/alpha', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `native-${++ip}` },
      body: new URLSearchParams({ ...valid, website: '' }),
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/alpha?received=1');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.store).toHaveBeenCalledWith(valid);
  });
  it.each([{ email: 'invalid' }, { website: 'bot' }, { purpose: 'x'.repeat(1001) }])(
    'uses the same validation and bot guard on native form POST %j', async patch => {
      const response = await route.POST(new Request('http://localhost/api/alpha', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `native-invalid-${++ip}` },
        body: new URLSearchParams({ ...valid, ...patch }),
      }));
      expect(response.status).toBe(400);
      expect(mocks.store).not.toHaveBeenCalled();
    },
  );
  it.each(ALPHA_INTENTS)('stores %s signed-out and confirms contact without creating an account', async intent => {
    const response = await route.POST(request({ ...valid, intent, name: ' Test Person ', email: ' Person@Example.com ', website: '' }));
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ message: 'Thank you — someone from Imajin will reach out to you.' });
    expect(mocks.store).toHaveBeenCalledWith({ ...valid, intent });
    expect(Object.keys(route)).toEqual(['POST']);
  });

  const invalidFields = Object.keys(ALPHA_LIMITS).flatMap(field => [
    [field, ''], [field, '   '], [field, null], [field, 123], [field, 'x'.repeat(ALPHA_LIMITS[field as keyof typeof ALPHA_LIMITS] + 1)],
  ]);
  it.each(invalidFields)('rejects invalid %s: %s without persistence', async (field, value) => {
    expect((await route.POST(request({ ...valid, [field as string]: value }))).status).toBe(400);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it.each(['not-an-email', 'a@', '@example.com', 'a b@example.com', 'a@example', 'a@example.com\nBcc:spam@example.com'])(
    'rejects malformed email %s', async email => {
      expect((await route.POST(request({ ...valid, email }))).status).toBe(400);
      expect(mocks.store).not.toHaveBeenCalled();
    },
  );
  it.each([null, [], 'text', 42, {}, { ...valid, extra: 'unexpected' }])('rejects malformed body %j', async body => {
    expect((await route.POST(request(body))).status).toBe(400);
  });
  it.each(['signup', '', null, ['demo'], 1])('rejects invalid intent %j', async intent => {
    expect((await route.POST(request({ ...valid, intent }))).status).toBe(400);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it.each(['https://spam.invalid', null, 1])('rejects a filled or malformed honeypot %j', async website => {
    expect((await route.POST(request({ ...valid, website }))).status).toBe(400);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it('accepts exact field length boundaries and never echoes submission data', async () => {
    const body = { ...valid, name: 'n'.repeat(120), company: 'c'.repeat(200), purpose: 'p'.repeat(1000),
      email: `${'e'.repeat(64)}@${'d'.repeat(63)}.${'d'.repeat(63)}.${'d'.repeat(57)}.com` };
    expect(body.email).toHaveLength(254);
    expect((await route.POST(request(body))).status).toBe(201);
  });
  it('limits actual bytes and rejects malformed/empty bodies with no storage', async () => {
    for (const body of [undefined, '{', JSON.stringify({ ...valid, purpose: '💡'.repeat(5000) })]) {
      const req = new Request('http://localhost/api/alpha', { method: 'POST', headers: { 'x-forwarded-for': `198.51.100.${++ip}` }, body });
      expect((await route.POST(req)).status).toBe(400);
    }
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it('counts failed and successful attempts per IP, returns Retry-After and resets after the window', async () => {
    vi.useFakeTimers();
    const address = `rate-${++ip}`;
    for (let index = 0; index < 5; index++) expect((await route.POST(request(index === 0 ? {} : valid, address))).status).toBe(index === 0 ? 400 : 201);
    const limited = await route.POST(request(valid, address));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBe(3600);
    expect(mocks.store).toHaveBeenCalledTimes(4);
    expect((await route.POST(request(valid))).status).toBe(201);
    vi.advanceTimersByTime(ALPHA_RATE_WINDOW_MS + 1);
    expect((await route.POST(request(valid, address))).status).toBe(201);
  });
  it('uses a shared fallback quota without forwarding headers', async () => {
    for (let index = 0; index < 5; index++) {
      expect((await route.POST(new Request('http://localhost/api/alpha', { method: 'POST', body: JSON.stringify(valid) }))).status).toBe(201);
    }
    expect((await route.POST(new Request('http://localhost/api/alpha', { method: 'POST', body: JSON.stringify(valid) }))).status).toBe(429);
  });
  it('never logs or returns submission content or database error details', async () => {
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')];
    mocks.store.mockRejectedValue(new Error(JSON.stringify(valid)));
    const response = await route.POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(valid.email);
    logs.forEach(log => expect(log).not.toHaveBeenCalled());
  });
});
