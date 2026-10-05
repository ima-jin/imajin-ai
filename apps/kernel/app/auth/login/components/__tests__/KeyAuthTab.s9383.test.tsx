// @vitest-environment jsdom
/**
 * KeyAuthTab — typescript:S9383 (#2568).
 *
 * Both the drop handler and the file input onChange wrap `handleFileSelect`
 * in `fireAndForget(...)`. A backup file with no private key makes
 * handleFileSelect surface an error message, which proves the handler still
 * ran to completion.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import KeyAuthTab from '../KeyAuthTab';

const MISSING_KEY = 'Invalid backup file format. Missing privateKey.';

function fakeFile(text: string, type = 'application/json') {
  return { type, text: async () => text } as unknown as File;
}

function renderTab() {
  return render(<KeyAuthTab nextUrl="/" onMfaRequired={vi.fn()} onSuccess={vi.fn()} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('KeyAuthTab fire-and-forget handlers', () => {
  it('handles a dropped JSON backup file', async () => {
    const { getByLabelText } = renderTab();
    fireEvent.drop(getByLabelText('File drop zone'), { dataTransfer: { files: [fakeFile('{}')] } });

    await waitFor(() => expect(screen.getByText(MISSING_KEY)).toBeDefined());
  });

  it('rejects a dropped non-JSON file without importing', async () => {
    const { getByLabelText } = renderTab();
    fireEvent.drop(getByLabelText('File drop zone'), {
      dataTransfer: { files: [fakeFile('{}', 'text/plain')] },
    });

    await waitFor(() => expect(screen.getByText('Please drop a valid JSON backup file')).toBeDefined());
  });

  it('handles a file chosen through the file input', async () => {
    const { container } = renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fakeFile('{}')] } });

    await waitFor(() => expect(screen.getByText(MISSING_KEY)).toBeDefined());
  });

  it('ignores a file input change with no file selected', async () => {
    const { container } = renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });

    await Promise.resolve();
    expect(screen.queryByText(MISSING_KEY)).toBeNull();
  });
});
