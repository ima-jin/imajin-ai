// @vitest-environment jsdom
/**
 * Smoke-render test for `MagicLinkButton`. Clicking the trigger reveals the
 * email form, mounting the input that carries the focus-on-mount ref
 * callback (S9379).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MagicLinkButton } from '../magic-link-button';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MagicLinkButton', () => {
  it('reveals the email input and focuses it on mount, without crashing', () => {
    render(<MagicLinkButton eventId="evt_1" />);

    fireEvent.click(screen.getByText('Already have a ticket?'));

    const input = screen.getByPlaceholderText('your@email.com');
    expect(input).toBeDefined();
    expect(document.activeElement).toBe(input);
  });
});
