// @vitest-environment jsdom
/**
 * Smoke-render test for `PresenceChat` (the default export). The stream
 * parsing/dispatch helpers extracted from it are already covered by
 * PresenceChat.test.ts; this covers the component itself mounting, which is
 * the only place its focus-on-mount ref callback (S9379) runs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PresenceChat } from '../PresenceChat';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PresenceChat', () => {
  it('renders the input, focusing it on mount, without crashing', () => {
    const onClose = vi.fn();
    render(
      <PresenceChat targetDid="did:imajin:alice" targetName="Alice" onClose={onClose} />,
    );

    const input = screen.getByPlaceholderText('Ask Alice...');
    expect(input).toBeDefined();
    expect(document.activeElement).toBe(input);
  });
});
