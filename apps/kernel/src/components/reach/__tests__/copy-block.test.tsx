// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CopyBlock } from '../copy-block';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CopyBlock', () => {
  it('copies only the public snippet and announces success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<CopyBlock label="Public URL" text="https://node.example/alex/reach" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Public URL' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied to clipboard.'));
    expect(writeText).toHaveBeenCalledWith('https://node.example/alex/reach');
  });

  it('offers manual copying if clipboard permission is denied', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<CopyBlock label="Public URL" text="public text" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Public URL' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Select and copy'));
    expect(screen.getByText('public text')).toBeTruthy();
  });

  it('offers manual copying when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    render(<CopyBlock label="Public URL" text="public text" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Public URL' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Copy unavailable.'));
  });
});
