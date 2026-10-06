// @vitest-environment jsdom
/**
 * AssetDetail — S9383 floating-promise fix (#2568).
 *
 * The v1.1 branch of the `.fair` edit modal calls the async `onSave` prop
 * without awaiting it: the synchronous setSaving/onCancel sequence must stay
 * exactly as before, and a rejected save is now logged via `fireAndForget`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Asset } from '@/src/db/schemas/media';

vi.mock('@imajin/fair/react', () => ({
  // Legacy (v1.0) editor stand-in: the writable instance (inside the modal)
  // exposes a button that switches the draft to a v1.1 manifest.
  FairEditor: ({ readOnly, onChange }: { readOnly?: boolean; onChange?: (m: unknown) => void }) =>
    readOnly ? null : (
      <button type="button" onClick={() => onChange?.(nextManifest)}>
        switch-to-v11
      </button>
    ),
}));

vi.mock('../FairManifestEditor', () => ({
  FairManifestEditor: ({ onSave }: { onSave: () => void }) => (
    <button type="button" onClick={onSave}>
      save-v11
    </button>
  ),
}));

let nextManifest: Record<string, unknown> = { version: '1.1', type: 'application/octet-stream' };

const { AssetDetail } = await import('../AssetDetail');

const OWNER = 'did:imajin:owner';

function makeAsset(): Asset {
  return {
    id: 'asset_1',
    ownerDid: OWNER,
    filename: 'file.bin',
    mimeType: 'application/octet-stream',
    size: 10,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    fairManifest: { version: '1.0' },
    metadata: null,
    folderId: null,
    immutable: false,
    versionCount: 1,
  } as unknown as Asset;
}

function openModalInV11Mode() {
  render(
    <AssetDetail
      asset={makeAsset()}
      folders={[]}
      currentDid={OWNER}
      onClose={() => {}}
      onDeleted={() => {}}
      onMoved={() => {}}
    />,
  );
  fireEvent.click(screen.getByText('Edit ✏️'));
  fireEvent.click(screen.getByText('switch-to-v11'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nextManifest = { version: '1.1', type: 'application/octet-stream' };
});

describe('v1.1 modal save', () => {
  it('saves the manifest and closes the modal synchronously', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    openModalInV11Mode();

    fireEvent.click(screen.getByText('save-v11'));

    // onCancel ran synchronously after the (unawaited) save was kicked off.
    expect(screen.queryByText('Edit .fair Manifest')).toBeNull();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/media/api/assets/asset_1/fair');
    expect(init.method).toBe('PUT');
  });

  it('logs instead of rejecting when the save throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as unknown as Response));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('cannot serialize');
    nextManifest = {
      version: '1.1',
      type: 'application/octet-stream',
      toJSON() {
        throw boom;
      },
    };
    openModalInV11Mode();

    fireEvent.click(screen.getByText('save-v11'));

    expect(screen.queryByText('Edit .fair Manifest')).toBeNull();
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[media:AssetDetail:fairSave] unhandled async error', boom),
    );
  });
});
