// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunsPreview } from '../runs-preview';
import PreviewPage from '../page';
import { installRunsPreview } from '../transport';

vi.mock('../transport', () => ({ installRunsPreview: vi.fn() }));
vi.mock('@/app/jin/runs-panel', () => ({ RunsPanel: () => <div>Runs fixture mounted</div> }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('404'); } }));
const install = vi.mocked(installRunsPreview);
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe('Runs fixture shell', () => {
  it('is absent in production and available only in development', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => PreviewPage()).toThrow('404');
    vi.stubEnv('NODE_ENV', 'development');
    expect(PreviewPage().type).toBe(RunsPreview);
  });

  it('mounts real lane only after fixture initialization and disposes transport', async () => {
    const dispose = vi.fn();
    install.mockResolvedValue({ dispose, client: {} as Awaited<ReturnType<typeof install>>['client'] });
    const view = render(<RunsPreview />);
    expect(await screen.findByText('Runs fixture mounted')).toBeDefined();
    expect(screen.getByText(/No live gateway execution/)).toBeDefined();
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reports fixture failure and never mounts a lane using real transport', async () => {
    install.mockRejectedValue(new Error('fixture failed'));
    render(<RunsPreview />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Fixture initialization failed.');
    expect(screen.queryByText('Runs fixture mounted')).toBeNull();
  });

  it('disposes initialization that completes after unmount', async () => {
    let resolve: (value: Awaited<ReturnType<typeof install>>) => void = () => {};
    install.mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<RunsPreview />);
    view.unmount();
    const dispose = vi.fn();
    resolve({ dispose, client: {} as Awaited<ReturnType<typeof install>>['client'] });
    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });
});
