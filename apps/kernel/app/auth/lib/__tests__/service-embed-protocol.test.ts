import { describe, it, expect } from 'vitest';
import { isAppToKernelMessage, normalizeToastLevel } from '../service-embed-protocol';

describe('isAppToKernelMessage (RFC-19, #2275)', () => {
  it('accepts a well-formed set_title message', () => {
    expect(isAppToKernelMessage({ type: 'set_title', title: 'My Listing' })).toBe(true);
  });

  it('accepts a well-formed set_badge message', () => {
    expect(isAppToKernelMessage({ type: 'set_badge', count: 3 })).toBe(true);
  });

  it('accepts a well-formed navigate message', () => {
    expect(isAppToKernelMessage({ type: 'navigate', path: '/market/listings/123' })).toBe(true);
  });

  it('accepts a well-formed toast message, with or without a level', () => {
    expect(isAppToKernelMessage({ type: 'toast', message: 'Purchase complete!' })).toBe(true);
    expect(isAppToKernelMessage({ type: 'toast', message: 'Purchase complete!', level: 'success' })).toBe(true);
  });

  it('rejects an unknown message type', () => {
    expect(isAppToKernelMessage({ type: 'request_payment', checkout: {} })).toBe(false);
  });

  it('rejects a Kernel -> App message misdirected at the kernel', () => {
    expect(isAppToKernelMessage({ type: 'session', token: 'abc' })).toBe(false);
  });

  it('rejects a message missing its required field', () => {
    expect(isAppToKernelMessage({ type: 'set_title' })).toBe(false);
    expect(isAppToKernelMessage({ type: 'set_badge', count: 'three' })).toBe(false);
    expect(isAppToKernelMessage({ type: 'navigate' })).toBe(false);
    expect(isAppToKernelMessage({ type: 'toast' })).toBe(false);
  });

  it('rejects non-object payloads', () => {
    expect(isAppToKernelMessage(null)).toBe(false);
    expect(isAppToKernelMessage('set_title')).toBe(false);
    expect(isAppToKernelMessage(42)).toBe(false);
    expect(isAppToKernelMessage(undefined)).toBe(false);
  });
});

describe('normalizeToastLevel (#2275)', () => {
  it('passes through each known toast level', () => {
    expect(normalizeToastLevel('success')).toBe('success');
    expect(normalizeToastLevel('error')).toBe('error');
    expect(normalizeToastLevel('warning')).toBe('warning');
    expect(normalizeToastLevel('info')).toBe('info');
  });

  it('defaults to info for an unknown or missing level', () => {
    expect(normalizeToastLevel('urgent')).toBe('info');
    expect(normalizeToastLevel(undefined)).toBe('info');
    expect(normalizeToastLevel(42)).toBe('info');
  });
});
