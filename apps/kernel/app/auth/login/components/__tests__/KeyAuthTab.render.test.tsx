// @vitest-environment jsdom
/**
 * Smoke-render test for `KeyAuthTab`. Switching to the "paste" method
 * mounts the textarea that carries the focus-on-mount ref callback (S9379).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import KeyAuthTab from '../KeyAuthTab';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('KeyAuthTab', () => {
  it('renders the paste-key textarea, focusing it on mount, without crashing', () => {
    render(
      <KeyAuthTab nextUrl={null} onMfaRequired={vi.fn()} onSuccess={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('Paste Key'));

    const textarea = screen.getByLabelText('Private Key (hex)');
    expect(textarea).toBeDefined();
    expect(document.activeElement).toBe(textarea);
  });
});
