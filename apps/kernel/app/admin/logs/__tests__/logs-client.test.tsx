// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LogsClient from '../logs-client';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('log service filters have no first-party enumeration', () => {
  it('queries any registry slug in structured and raw logs', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/admin/logs/raw')) {
        return Response.json({ service: 'fixture-studio', lines: 100, out: null, err: null });
      }
      return Response.json({ rows: [], total: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<LogsClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'fixture-studio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('service=fixture-studio')));
    fireEvent.click(screen.getByRole('button', { name: 'Raw Logs' }));
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'fixture-studio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tail logs' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/logs/raw?service=fixture-studio&lines=100'));
    await waitFor(() => expect(screen.getByText('fixture-studio')).toBeTruthy());
  });
});
