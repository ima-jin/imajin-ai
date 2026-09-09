// @vitest-environment jsdom
/**
 * Characterization tests for PasswordLoginSection and StatusBanner,
 * extracted from SecuritySettingsPage (#2119, cognitive complexity S3776).
 * The page had no prior tests; these pin the stored-key/MFA-recommendation
 * branching and flow visibility that used to live inline in the flagged
 * function.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import PasswordLoginSection from '../PasswordLoginSection';
import StatusBanner from '../StatusBanner';

afterEach(() => {
  cleanup();
});

function passwordProps(overrides: Partial<React.ComponentProps<typeof PasswordLoginSection>> = {}) {
  return {
    hasStoredKey: false,
    hasMfa: false,
    showPasswordChange: false,
    showPasswordReset: false,
    showPasswordSetup: false,
    currentPassword: '',
    password: '',
    confirmPassword: '',
    actionLoading: '',
    onOpenChange: vi.fn(),
    onOpenSetup: vi.fn(),
    onSwitchToReset: vi.fn(),
    onCancelChange: vi.fn(),
    onCancelReset: vi.fn(),
    onCancelSetup: vi.fn(),
    setCurrentPassword: vi.fn(),
    setPassword: vi.fn(),
    setConfirmPassword: vi.fn(),
    handlePasswordChange: vi.fn(),
    handlePasswordReset: vi.fn(),
    handlePasswordSetup: vi.fn(),
    ...overrides,
  };
}

describe('PasswordLoginSection', () => {
  it('shows "Not set up" and a Set up button when there is no stored key', () => {
    render(<PasswordLoginSection {...passwordProps()} />);
    expect(screen.getByText('Not set up')).toBeDefined();
    expect(screen.getByText('Set up password')).toBeDefined();
  });

  it('shows "Active" and a Change password button when a stored key exists', () => {
    render(<PasswordLoginSection {...passwordProps({ hasStoredKey: true })} />);
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('Change password')).toBeDefined();
  });

  it('recommends MFA only when a stored key exists without any MFA configured', () => {
    const { rerender } = render(<PasswordLoginSection {...passwordProps({ hasStoredKey: false, hasMfa: false })} />);
    expect(screen.queryByText(/We recommend setting up an additional MFA method/)).toBeNull();

    rerender(<PasswordLoginSection {...passwordProps({ hasStoredKey: true, hasMfa: true })} />);
    expect(screen.queryByText(/We recommend setting up an additional MFA method/)).toBeNull();

    rerender(<PasswordLoginSection {...passwordProps({ hasStoredKey: true, hasMfa: false })} />);
    expect(screen.getByText(/We recommend setting up an additional MFA method/)).toBeDefined();
  });

  it('shows the change-password flow only when showPasswordChange is true and a stored key exists', () => {
    const { rerender } = render(
      <PasswordLoginSection {...passwordProps({ showPasswordChange: true, hasStoredKey: false })} />,
    );
    expect(screen.queryByText('Enter your current password to verify, then choose a new one.')).toBeNull();

    rerender(<PasswordLoginSection {...passwordProps({ showPasswordChange: true, hasStoredKey: true })} />);
    expect(screen.getByText('Enter your current password to verify, then choose a new one.')).toBeDefined();
  });

  it('shows the setup flow only when showPasswordSetup is true and there is no stored key', () => {
    const { rerender } = render(
      <PasswordLoginSection {...passwordProps({ showPasswordSetup: true, hasStoredKey: true })} />,
    );
    expect(screen.queryByText('Set up password login')).toBeNull();

    rerender(<PasswordLoginSection {...passwordProps({ showPasswordSetup: true, hasStoredKey: false })} />);
    expect(screen.getByText('Set up password login')).toBeDefined();
  });
});

describe('StatusBanner', () => {
  it('renders nothing when there is no status message', () => {
    const { container } = render(<StatusBanner statusMessage={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the success text', () => {
    render(<StatusBanner statusMessage={{ type: 'success', text: 'Saved!' }} />);
    expect(screen.getByText('Saved!')).toBeDefined();
  });

  it('renders the error text', () => {
    render(<StatusBanner statusMessage={{ type: 'error', text: 'Something broke' }} />);
    expect(screen.getByText('Something broke')).toBeDefined();
  });
});
