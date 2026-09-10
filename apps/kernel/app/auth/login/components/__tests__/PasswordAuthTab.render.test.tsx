// @vitest-environment jsdom
/**
 * Smoke-render test for `PasswordAuthTab`. The default ('identifier') step
 * mounts the handle input that carries the shared focus-on-mount ref
 * callback (S9379).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import PasswordAuthTab from '../PasswordAuthTab';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PasswordAuthTab', () => {
  it('renders the handle input, focusing it on mount, without crashing', () => {
    render(
      <PasswordAuthTab nextUrl={null} onMfaRequired={vi.fn()} onSuccess={vi.fn()} />,
    );

    const input = screen.getByLabelText('Handle');
    expect(input).toBeDefined();
    expect(document.activeElement).toBe(input);
  });
});
