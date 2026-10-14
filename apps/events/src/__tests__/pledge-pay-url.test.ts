import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceUrl } from '../lib/pledge-pay-url';

beforeEach(() => {
  vi.stubEnv('PAY_SERVICE_URL', '');
  vi.stubEnv('IMAJIN_KERNEL_URL', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('pledge pay URL', () => {
  it('fails closed without configuration', () => {
    expect(serviceUrl('pay')).toBeNull();
  });
  it('uses the configured pay override', () => {
    vi.stubEnv('PAY_SERVICE_URL', 'https://pay.test');
    expect(serviceUrl('pay')).toBe('https://pay.test');
  });
  it.each(['https://kernel.test', 'https://kernel.test/'])('resolves the kernel pay prefix (%s)', (url) => {
    vi.stubEnv('IMAJIN_KERNEL_URL', url);
    expect(serviceUrl('pay')).toBe('https://kernel.test/pay');
  });
});
