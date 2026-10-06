// @vitest-environment jsdom
/**
 * AssetFilename — S9383 floating-promise fixes (#2568).
 *
 * `commit()` is fired from the blur and Enter handlers without being awaited.
 * Both call sites now go through `fireAndForget`, so behaviour is unchanged on
 * success and a rejection (here: a throwing `onRenamed` callback) is logged
 * rather than escaping as an unhandled rejection.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { AssetFilename } from '../AssetFilename';

const OLD_NAME = 'notes.md';
const NEW_NAME = 'meeting-notes.md';

function installFetch() {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, filename: NEW_NAME }),
  }) as unknown as Response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function openEditor(onRenamed: (filename: string) => void) {
  render(
    <AssetFilename assetId="asset_1" filename={OLD_NAME} isOwner immutable={false} onRenamed={onRenamed} />,
  );
  fireEvent.click(screen.getByRole('button', { name: `Rename ${OLD_NAME}` }));
  const field = screen.getByRole('textbox', { name: 'Asset filename' });
  fireEvent.change(field, { target: { value: NEW_NAME } });
  return field;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('blur commit', () => {
  it('commits the rename when the input loses focus', async () => {
    const spy = installFetch();
    const onRenamed = vi.fn();
    const field = openEditor(onRenamed);

    fireEvent.blur(field);

    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith(NEW_NAME));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('logs instead of rejecting when the commit throws', async () => {
    installFetch();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('onRenamed failed');
    const field = openEditor(() => {
      throw boom;
    });

    fireEvent.blur(field);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[media:AssetFilename:blurCommit] unhandled async error', boom),
    );
  });
});

describe('Enter commit', () => {
  it('logs instead of rejecting when the commit throws', async () => {
    installFetch();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('onRenamed failed');
    const field = openEditor(() => {
      throw boom;
    });

    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[media:AssetFilename:enterCommit] unhandled async error', boom),
    );
  });
});
