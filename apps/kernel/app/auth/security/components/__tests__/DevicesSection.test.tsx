// @vitest-environment jsdom
/**
 * Characterization tests for DevicesSection and its pure display helpers,
 * extracted from SecuritySettingsPage (#2119, cognitive complexity S3776).
 * The page had no prior tests; these pin the device-list rendering and
 * trust/remove wiring that used to live inline in the flagged function.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import DevicesSection, { truncateUserAgent, describeDevice, type Device } from '../DevicesSection';

afterEach(() => {
  cleanup();
});

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 'dev_1',
    fingerprint: 'fp_1',
    name: null,
    ip: '1.2.3.4',
    userAgent: 'Mozilla/5.0',
    platform: 'macOS',
    browser: 'Chrome',
    trusted: false,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('truncateUserAgent', () => {
  it('returns a placeholder for a missing user agent', () => {
    expect(truncateUserAgent(null)).toBe('Unknown device');
  });

  it('returns short user agents unchanged', () => {
    expect(truncateUserAgent('short-ua')).toBe('short-ua');
  });

  it('truncates long user agents to 57 chars plus an ellipsis', () => {
    const ua = 'a'.repeat(100);
    const result = truncateUserAgent(ua);
    expect(result).toBe(`${'a'.repeat(57)}…`);
  });
});

describe('describeDevice', () => {
  it('prefers "browser on platform" when both are known', () => {
    expect(describeDevice(makeDevice({ browser: 'Chrome', platform: 'macOS' }))).toBe('Chrome on macOS');
  });

  it('falls back to the truncated user agent when browser/platform are unknown', () => {
    expect(describeDevice(makeDevice({ browser: null, platform: null, userAgent: 'curl/8.0' }))).toBe('curl/8.0');
  });
});

describe('DevicesSection', () => {
  it('shows an empty state when there are no devices', () => {
    render(<DevicesSection devices={[]} actionLoading="" onTrustDevice={vi.fn()} onRemoveDevice={vi.fn()} />);
    expect(screen.getByText('No devices recorded yet.')).toBeDefined();
  });

  it('renders each device with a description and last-seen date', () => {
    render(
      <DevicesSection
        devices={[makeDevice({ id: 'dev_1' })]}
        actionLoading=""
        onTrustDevice={vi.fn()}
        onRemoveDevice={vi.fn()}
      />,
    );
    expect(screen.getByText('Chrome on macOS')).toBeDefined();
    expect(screen.getByText(/Last seen/)).toBeDefined();
  });

  it('shows a Trust button only for untrusted devices, and a Trusted badge only for trusted ones', () => {
    render(
      <DevicesSection
        devices={[makeDevice({ id: 'dev_1', trusted: false }), makeDevice({ id: 'dev_2', trusted: true })]}
        actionLoading=""
        onTrustDevice={vi.fn()}
        onRemoveDevice={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Trust')).toHaveLength(1);
    expect(screen.getAllByText('Trusted')).toHaveLength(1);
  });

  it('invokes onTrustDevice and onRemoveDevice with the device id', () => {
    const onTrustDevice = vi.fn();
    const onRemoveDevice = vi.fn();
    render(
      <DevicesSection
        devices={[makeDevice({ id: 'dev_1', trusted: false })]}
        actionLoading=""
        onTrustDevice={onTrustDevice}
        onRemoveDevice={onRemoveDevice}
      />,
    );
    fireEvent.click(screen.getByText('Trust'));
    fireEvent.click(screen.getByText('Remove'));
    expect(onTrustDevice).toHaveBeenCalledWith('dev_1');
    expect(onRemoveDevice).toHaveBeenCalledWith('dev_1');
  });

  it('disables the Remove button only for the device currently loading', () => {
    render(
      <DevicesSection
        devices={[makeDevice({ id: 'dev_1' }), makeDevice({ id: 'dev_2' })]}
        actionLoading="device-dev_1"
        onTrustDevice={vi.fn()}
        onRemoveDevice={vi.fn()}
      />,
    );
    const removeButtons = screen.getAllByText('Remove') as HTMLButtonElement[];
    expect(removeButtons[0].disabled).toBe(true);
    expect(removeButtons[1].disabled).toBe(false);
  });
});
