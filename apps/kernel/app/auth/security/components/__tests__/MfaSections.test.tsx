// @vitest-environment jsdom
/**
 * Characterization tests for TotpSection and EmailMfaSection, extracted from
 * SecuritySettingsPage (#2119, cognitive complexity S3776). The page had no
 * prior tests; these pin the enabled/not-set-up branching and setup/disable
 * flow visibility that used to live inline in the flagged function.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import TotpSection from '../TotpSection';
import EmailMfaSection from '../EmailMfaSection';

afterEach(() => {
  cleanup();
});

function totpProps(overrides: Partial<React.ComponentProps<typeof TotpSection>> = {}) {
  return {
    hasTotpEnabled: false,
    showTotpSetup: false,
    totpSetup: null,
    totpCode: '',
    showTotpDisable: false,
    totpDisableCode: '',
    actionLoading: '',
    onStartSetup: vi.fn(),
    onOpenDisable: vi.fn(),
    onCancelSetup: vi.fn(),
    onCancelDisable: vi.fn(),
    setTotpCode: vi.fn(),
    setTotpDisableCode: vi.fn(),
    handleVerifyTotp: vi.fn(),
    handleDisableTotp: vi.fn(),
    ...overrides,
  };
}

describe('TotpSection', () => {
  it('shows "Not set up" and a Set up button when TOTP is disabled', () => {
    render(<TotpSection {...totpProps()} />);
    expect(screen.getByText('Not set up')).toBeDefined();
    expect(screen.getByText('Set up')).toBeDefined();
  });

  it('shows "Active" and a Remove button when TOTP is enabled', () => {
    render(<TotpSection {...totpProps({ hasTotpEnabled: true })} />);
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('Remove')).toBeDefined();
  });

  it('invokes onStartSetup when Set up is clicked', () => {
    const onStartSetup = vi.fn();
    render(<TotpSection {...totpProps({ onStartSetup })} />);
    fireEvent.click(screen.getByText('Set up'));
    expect(onStartSetup).toHaveBeenCalledOnce();
  });

  it('only shows the QR setup panel when showTotpSetup and totpSetup are both present', () => {
    const { rerender } = render(<TotpSection {...totpProps({ showTotpSetup: true, totpSetup: null })} />);
    expect(screen.queryByText('Scan QR code')).toBeNull();

    rerender(
      <TotpSection
        {...totpProps({
          showTotpSetup: true,
          totpSetup: { secret: 'ABC123', otpauthUrl: 'otpauth://x', qrCode: 'data:image/png;base64,x' },
        })}
      />,
    );
    expect(screen.getByText('Scan QR code')).toBeDefined();
    expect(screen.getByText(/ABC123/)).toBeDefined();
  });

  it('only enables Confirm once the code is 6 digits', () => {
    render(
      <TotpSection
        {...totpProps({
          showTotpSetup: true,
          totpSetup: { secret: 'ABC123', otpauthUrl: 'otpauth://x', qrCode: 'x' },
          totpCode: '12345',
        })}
      />,
    );
    expect((screen.getByText('Confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the disable-confirmation panel only when showTotpDisable is true', () => {
    render(<TotpSection {...totpProps({ showTotpDisable: true })} />);
    expect(screen.getByText('Confirm removal')).toBeDefined();
  });
});

function emailProps(overrides: Partial<React.ComponentProps<typeof EmailMfaSection>> = {}) {
  return {
    hasEmailMfa: false,
    showEmailSetup: false,
    emailCode: '',
    actionLoading: '',
    onStartSetup: vi.fn(),
    onDisable: vi.fn(),
    onCancelSetup: vi.fn(),
    setEmailCode: vi.fn(),
    handleVerifyEmailSetup: vi.fn(),
    ...overrides,
  };
}

describe('EmailMfaSection', () => {
  it('shows "Not set up" and an Enable button when email MFA is disabled', () => {
    render(<EmailMfaSection {...emailProps()} />);
    expect(screen.getByText('Not set up')).toBeDefined();
    expect(screen.getByText('Enable')).toBeDefined();
  });

  it('shows "Active" and a Disable button when email MFA is enabled', () => {
    render(<EmailMfaSection {...emailProps({ hasEmailMfa: true })} />);
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('Disable')).toBeDefined();
  });

  it('invokes onDisable when Disable is clicked', () => {
    const onDisable = vi.fn();
    render(<EmailMfaSection {...emailProps({ hasEmailMfa: true, onDisable })} />);
    fireEvent.click(screen.getByText('Disable'));
    expect(onDisable).toHaveBeenCalledOnce();
  });

  it('shows the verify panel only when showEmailSetup is true and email MFA is not yet enabled', () => {
    const { rerender } = render(<EmailMfaSection {...emailProps({ showEmailSetup: false })} />);
    expect(screen.queryByText('Verify your email')).toBeNull();

    rerender(<EmailMfaSection {...emailProps({ showEmailSetup: true, hasEmailMfa: true })} />);
    expect(screen.queryByText('Verify your email')).toBeNull();

    rerender(<EmailMfaSection {...emailProps({ showEmailSetup: true, hasEmailMfa: false })} />);
    expect(screen.getByText('Verify your email')).toBeDefined();
  });
});
