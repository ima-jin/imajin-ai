// @vitest-environment jsdom
import { createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FairEditor } from '../src/react';
import type { FairEditorProps } from '../src/react';
import type { SupportedFairManifest } from '../src/types';
import { validateManifest } from '../src/validate';
import { buildFairManifest } from '../src/buildManifest';
import { storedDocumentManifest, storedFeeManifest } from './fixtures/stored-manifests';

afterEach(cleanup);

function panel(title: string): HTMLElement {
  const element = screen.getByRole('heading', { name: title }).parentElement;
  if (!element) throw new Error(`Missing panel: ${title}`);
  return element;
}

function SaveHarness({ manifest, onSave }: Readonly<{
  manifest: SupportedFairManifest;
  onSave: (serialized: string) => void;
}>) {
  const [draft, setDraft] = useState(manifest);
  return createElement('div', null,
    createElement(FairEditor<SupportedFairManifest>, { manifest, onChange: setDraft }),
    createElement('button', {
      type: 'button',
      onClick: () => {
        const result = validateManifest(draft);
        if (!result.ok) throw new Error(result.errors.join(', '));
        onSave(JSON.stringify(draft));
      },
    }, 'Save manifest'),
  );
}

describe('FairEditor lossless load/edit/save', () => {
  it.each([
    ['stored document', storedDocumentManifest],
    ['stored event fee', storedFeeManifest],
  ])('round-trips a %s before and after an attribution edit', (_label, manifest) => {
    const original = JSON.stringify(manifest);
    const save = vi.fn();
    const view = render(createElement(SaveHarness, { manifest, onSave: save }));
    fireEvent.click(screen.getByRole('button', { name: 'Save manifest' }));
    expect(save).toHaveBeenLastCalledWith(original);

    // Trigger an actual editor update; saving must retain every untouched field.
    fireEvent.change(within(panel('Attribution')).getAllByPlaceholderText('Note (optional)')[0], {
      target: { value: 'Organizer attribution' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save manifest' }));
    const serialized = save.mock.calls[1][0] as string;
    const saved = JSON.parse(serialized) as SupportedFairManifest;
    expect(saved).toEqual({
      ...manifest,
      attribution: manifest.attribution.map((entry, i) =>
        i === 0 ? { ...entry, note: 'Organizer attribution' } : entry),
    });
    expect(validateManifest(saved).ok).toBe(true);
    expect(JSON.stringify(manifest)).toBe(original);

    view.unmount();
    render(createElement(SaveHarness, { manifest: saved, onSave: save }));
    expect(within(panel('Attribution')).getAllByPlaceholderText('Note (optional)')[0])
      .toHaveProperty('value', 'Organizer attribution');
    fireEvent.click(screen.getByRole('button', { name: 'Save manifest' }));
    expect(save).toHaveBeenLastCalledWith(serialized);
  });

  it('renders a builder event, without document panels even with a document template', () => {
    const manifest = buildFairManifest({
      creatorDid: 'did:imajin:organizer', contentDid: 'event:2787', contentType: 'event',
    });
    const change = vi.fn();
    render(createElement(FairEditor, { manifest, onChange: change, template: 'custom' }));
    expect(screen.getByText('v0.4.0')).toBeTruthy();
    expect(screen.getByText('Event fee manifest')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Access' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Transfer' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Integrity' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Processing Fees' })).toBeTruthy();
    fireEvent.change(within(panel('Distributions')).getByPlaceholderText('Note (optional)'), {
      target: { value: 'Revenue recipient' },
    });
    const saved = change.mock.calls[0][0] as SupportedFairManifest;
    expect(saved).toEqual({
      ...manifest, distributions: [{ ...manifest.distributions[0], note: 'Revenue recipient' }],
    });
    expect(validateManifest(saved).ok).toBe(true);
    expect(saved).not.toHaveProperty('fair');
    expect(saved).not.toHaveProperty('owner');
    expect(saved).not.toHaveProperty('access');
  });

  it('preserves taxes, signatures and stored extensions when editing a taxed fee record', () => {
    const manifest = {
      ...buildFairManifest({
        creatorDid: 'did:imajin:organizer', contentDid: 'event:2787', contentType: 'event',
        basisAmountCents: 1000,
        taxes: [{
          jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300,
          registrationNumber: '123456789RT0001',
          collectorDid: 'did:imajin:organizer', remitTo: 'did:imajin:authority:ca-cra',
        }],
      }),
      signature: { algorithm: 'ed25519', value: 'a'.repeat(128), publicKeyRef: 'did:imajin:organizer' },
      eventMetadata: { id: 'event:2787', buyers: ['buyer:existing'] },
    };
    const save = vi.fn();
    render(createElement(SaveHarness, { manifest, onSave: save }));
    fireEvent.change(within(panel('Attribution')).getByPlaceholderText('Note (optional)'), {
      target: { value: 'Taxed event attribution' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save manifest' }));
    const saved = JSON.parse(save.mock.calls[0][0]) as typeof manifest;
    expect(saved.version).toBe('0.5.0');
    expect(saved.taxes).toEqual(manifest.taxes);
    expect(saved.signature).toEqual(manifest.signature);
    expect(saved.eventMetadata).toEqual(manifest.eventMetadata);
    expect(saved.chain).toEqual(manifest.chain);
    expect(saved.fees).toEqual(manifest.fees);
    expect(saved.distributions).toEqual(manifest.distributions);
  });

  it('preserves absent chain and string access on document attribution edits', () => {
    const manifest = { ...storedDocumentManifest, access: 'public' as const };
    delete manifest.chain;
    const change = vi.fn();
    render(createElement(FairEditor, { manifest, onChange: change }));
    fireEvent.change(within(panel('Attribution')).getAllByPlaceholderText('Note (optional)')[0], {
      target: { value: 'Changed' },
    });
    expect(change.mock.calls[0][0]).not.toHaveProperty('chain');
    expect(change.mock.calls[0][0].access).toBe('public');
    fireEvent.click(screen.getByRole('button', { name: 'private' }));
    expect(change.mock.calls[1][0].access).toEqual({ type: 'private' });
  });

  it.each([storedDocumentManifest, storedFeeManifest])('keeps typing focus and row identity across edits', manifest => {
    render(createElement(FairEditor, { manifest }));
    const note = within(panel('Attribution')).getAllByPlaceholderText('Note (optional)')[0];
    note.focus();
    for (const value of ['C', 'Cr', 'Creator credit']) {
      fireEvent.change(note, { target: { value } });
      expect(document.activeElement).toBe(note);
      expect(note).toHaveProperty('value', value);
    }
    const chainDid = within(panel('Revenue Chain')).getAllByPlaceholderText('did:key:...')
      .find(element => !(element as HTMLInputElement).readOnly);
    if (!chainDid) throw new Error('Missing editable chain DID');
    chainDid.focus();
    fireEvent.change(chainDid, { target: { value: 'did:imajin:edited-node' } });
    expect(document.activeElement).toBe(chainDid);
    expect(chainDid).toHaveProperty('value', 'did:imajin:edited-node');
  });

  it('reloads incoming records and changes shape without retaining stale fields', () => {
    const change = vi.fn();
    const props: FairEditorProps = { manifest: storedDocumentManifest, onChange: change };
    const view = render(createElement(FairEditor, props));
    expect(screen.getByRole('heading', { name: 'Access' })).toBeTruthy();
    view.rerender(createElement(FairEditor, { ...props, manifest: storedFeeManifest }));
    expect(screen.queryByRole('heading', { name: 'Access' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Distributions' })).toBeTruthy();
    fireEvent.change(within(panel('Attribution')).getAllByPlaceholderText('Note (optional)')[0], {
      target: { value: 'Event only' },
    });
    expect(change.mock.calls[0][0]).toEqual({
      ...storedFeeManifest,
      attribution: storedFeeManifest.attribution.map((entry, i) =>
        i === 0 ? { ...entry, note: 'Event only' } : entry),
    });
    view.rerender(createElement(FairEditor, props));
    expect(screen.getByRole('heading', { name: 'Access' })).toBeTruthy();
    expect(screen.queryByText('Event fee manifest')).toBeNull();
  });

  it('adds and removes rows without writing editor identity into the manifest', () => {
    const change = vi.fn();
    render(createElement(FairEditor, { manifest: storedFeeManifest, onChange: change }));
    const attribution = within(panel('Attribution'));
    fireEvent.click(attribution.getByRole('button', { name: '+ Add contributor' }));
    expect(change.mock.calls[0][0].attribution[1]).toEqual({ did: '', role: 'collaborator', share: 0 });
    fireEvent.click(attribution.getAllByTitle('Remove')[1]);
    expect(change.mock.calls[1][0]).toEqual(storedFeeManifest);
    const chain = within(panel('Revenue Chain'));
    fireEvent.click(chain.getByRole('button', { name: '+ Add chain entry' }));
    expect(change.mock.calls[2][0].chain.at(-1)).toEqual({ did: '', role: 'seller', share: 0 });
    fireEvent.click(chain.getAllByTitle('Remove').at(-1)!);
    expect(change.mock.calls[3][0]).toEqual(storedFeeManifest);
  });

  it.each([storedFeeManifest, storedDocumentManifest])('renders read-only without emitting edits', manifest => {
    const change = vi.fn();
    render(createElement(FairEditor, {
      manifest, onChange: change, readOnly: true,
      sections: ['attribution', 'chain', 'fees', 'distributions', 'access', 'transfer', 'integrity'],
    }));
    expect(screen.getByRole('heading', { name: 'Attribution' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('Note (optional)')).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });
});
