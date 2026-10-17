import { describe, expect, it } from 'vitest';
import { isLiveAppAuthorization } from '../live-app-authorization';

describe('live app authorization', () => {
  it('allows indefinite and future expiry grants only', () => {
    expect(isLiveAppAuthorization({ expiresAt: null }, 100)).toBe(true);
    expect(isLiveAppAuthorization({ expiresAt: new Date(101) }, 100)).toBe(true);
    expect(isLiveAppAuthorization({ expiresAt: new Date(100) }, 100)).toBe(false);
    expect(isLiveAppAuthorization({ expiresAt: new Date(99) }, 100)).toBe(false);
  });
  it('never accepts a revoked grant', () => {
    expect(isLiveAppAuthorization({ revokedAt: new Date(1) }, 100)).toBe(false);
  });
});
