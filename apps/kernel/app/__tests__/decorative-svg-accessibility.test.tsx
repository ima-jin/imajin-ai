// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import DocumentSigningCard, { type DocumentAttestation } from '../auth/attestations/components/DocumentSigningCard';
import { PresenceChat } from '../profile/components/PresenceChat';
import { VoiceMessage } from '../../../../packages/chat/src/VoiceMessage';
import { MediaMessage } from '../../../../packages/chat/src/MediaMessage';
import { LocationMessage } from '../../../../packages/chat/src/LocationMessage';
import { ImajinInput } from '../../../../packages/input/src/ImajinInput';

// Include conditional branches (pause, transcription, subscription success, and
// denied chat access) without needing network, media devices, or a database.
const decorativeSvgSources = [
  ['packages/input/src/ImajinInput.tsx', 4],
  ['packages/chat/src/VoiceMessage.tsx', 3],
  ['packages/chat/src/Chat.tsx', 2],
  ['packages/chat/src/MediaMessage.tsx', 1],
  ['packages/chat/src/LocationMessage.tsx', 1],
  ['apps/kernel/app/auth/attestations/components/DocumentSigningCard.tsx', 1],
  ['apps/kernel/app/auth/components/AttestationList.tsx', 1],
  ['apps/kernel/app/subscribe/page.tsx', 1],
  ['apps/kernel/app/profile/components/PresenceChat.tsx', 1],
  ['apps/kernel/app/pay/history/TransactionList.tsx', 1],
] as const;

afterEach(cleanup);

describe('decorative SVG accessibility (#2862)', () => {
  it.each(decorativeSvgSources)('%s hides its %i decorative SVGs', (path, count) => {
    const sourceText = readFileSync(resolve(process.cwd(), path), 'utf8');
    const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const svgs: ts.JsxOpeningElement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'svg') {
        svgs.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(svgs).toHaveLength(count);
    for (const svg of svgs) {
      const hidden = svg.attributes.properties.find(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'aria-hidden',
      );
      expect(hidden?.getText(source)).toBe('aria-hidden="true"');
    }
    const compiled = ts.transpileModule(sourceText, {
      fileName: path,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext },
      reportDiagnostics: true,
    });
    expect(compiled.diagnostics).toEqual([]);
  });

  it('keeps the presence close controls named and operable', () => {
    const onClose = vi.fn();
    const { container } = render(
      <PresenceChat targetDid="did:imajin:alice" targetName="Alice" onClose={onClose} />,
    );

    const closeButtons = screen.getAllByRole('button', { name: 'Close presence chat' });
    expect(closeButtons).toHaveLength(2);
    for (const button of closeButtons) {
      fireEvent.click(button);
    }
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('names the document toggle and exposes its expanded state', () => {
    const attestation: DocumentAttestation = {
      id: 'document-1',
      issuerDid: 'did:imajin:alice',
      subjectDid: 'did:imajin:bob',
      type: 'document.created',
      payload: { title: 'Community agreement' },
      attestationStatus: 'executed',
      documentHash: null,
      documentAssetId: null,
      totalSigners: 0,
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: null,
    };
    const { container } = render(
      <DocumentSigningCard attestation={attestation} signatures={[]} sessionDid="did:imajin:bob" />,
    );

    const toggle = screen.getByRole('button', { name: 'Document details: Community agreement' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Signers')).toBeDefined();
    fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps voice playback and transcript controls named without exposing their icons', () => {
    const { container } = render(
      <VoiceMessage assetId="voice-1" transcript="Hello, community" durationMs={3000} isOwn={false} />,
    );

    expect(screen.getByRole('button', { name: 'Play' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    expect(screen.getByText('Hello, community')).toBeDefined();
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('keeps attachment and location links identifiable by their visible content', () => {
    render(
      <>
        <MediaMessage assetId="file-1" filename="agreement.pdf" mimeType="application/pdf" size={1024} isOwn={false} />
        <LocationMessage lat={43.65} lng={-79.38} label="Community hall" isOwn={false} />
      </>,
    );

    expect(screen.getByRole('link', { name: /agreement\.pdf/ }).getAttribute('download')).toBe('agreement.pdf');
    expect(screen.getByRole('link', { name: /Community hall/ }).getAttribute('href')).toContain('openstreetmap.org');
  });

  it('keeps input action names when their icons are hidden', () => {
    const onSubmit = vi.fn();
    const { container } = render(<ImajinInput features={['emoji', 'files']} onSubmit={onSubmit} />);

    expect(screen.getByRole('button', { name: 'Emoji' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDefined();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith('Hello');
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
