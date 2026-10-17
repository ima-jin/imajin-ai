// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import AuthLayoutShell from '../AuthLayoutShell';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), pathname: '/auth' }));
vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.pathname = '/auth';
});

describe('identity landing service', () => {
  it.each([
    ['pay', '/pay'],
    ['media', '/media'],
    ['coffee', '/auth/coffee'],
  ])('navigates %s directly to %s', (landingService, href) => {
    render(<AuthLayoutShell leftRail={null} identityDetail={null} tabBar={null} landingService={landingService}>Profile</AuthLayoutShell>);
    expect(mocks.replace).toHaveBeenCalledWith(href);
  });

  it('does not navigate away from identity subpages', () => {
    mocks.pathname = '/auth/settings';
    render(<AuthLayoutShell leftRail={null} identityDetail={null} tabBar={null} landingService="pay">Settings</AuthLayoutShell>);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
