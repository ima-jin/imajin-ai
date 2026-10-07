// @vitest-environment jsdom
/**
 * Component tests for the read-only scope-declarations preview on the
 * apps.provision card (#2663): the operator sees the providesScopes / dependsOn
 * list read from imajin.app.json BEFORE approving it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { ProvisionDeclarationsPreview } from '../provision-declarations-preview';

afterEach(cleanup);

const DEPENDENCY_ID = 'provision-declarations-dependency';

describe('ProvisionDeclarationsPreview', () => {
  it('lists the scopes the app provides and each dependency audience with its scopes', () => {
    render(
      <ProvisionDeclarationsPreview
        detail={{
          slug: 'dykil',
          manifestDeclarations: {
            providesScopes: ['dykil:read', 'dykil:write'],
            dependsOn: [
              { aud: 'jin.imajin.ai', scopes: ['media:read', 'media:write'] },
              { aud: 'events.imajin.ai', scopes: ['events:read'] },
            ],
          },
        }}
      />,
    );

    const preview = screen.getByTestId('provision-declarations-preview');
    expect(preview.getAttribute('data-state')).toBe('declared');
    expect(screen.getByTestId('provision-declarations-provides').textContent).toBe('dykil:read, dykil:write');

    const dependencies = screen.getAllByTestId(DEPENDENCY_ID);
    expect(dependencies).toHaveLength(2);
    expect(within(dependencies[0]).getByText('jin.imajin.ai')).toBeDefined();
    expect(within(dependencies[0]).getByText('media:read, media:write')).toBeDefined();
    expect(within(dependencies[1]).getByText('events.imajin.ai')).toBeDefined();
    expect(within(dependencies[1]).getByText('events:read')).toBeDefined();
  });

  it('says that approving registers exactly this list and nothing beyond it', () => {
    render(
      <ProvisionDeclarationsPreview
        detail={{ manifestDeclarations: { providesScopes: ['dykil:read'], dependsOn: [] } }}
      />,
    );

    expect(screen.getByText(/approving registers exactly this list, nothing beyond it/)).toBeDefined();
  });

  it('is read-only: it renders no inputs or buttons', () => {
    render(
      <ProvisionDeclarationsPreview
        detail={{ manifestDeclarations: { providesScopes: ['dykil:read'], dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }] } }}
      />,
    );

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('shows a dash for an empty side when the app only provides scopes, or only depends on services', () => {
    const { unmount } = render(
      <ProvisionDeclarationsPreview detail={{ manifestDeclarations: { providesScopes: ['dykil:read'], dependsOn: [] } }} />,
    );
    expect(screen.getByTestId('provision-declarations-depends').textContent).toContain('\u2014');
    expect(screen.queryAllByTestId(DEPENDENCY_ID)).toHaveLength(0);
    unmount();

    render(
      <ProvisionDeclarationsPreview
        detail={{ manifestDeclarations: { providesScopes: [], dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }] } }}
      />,
    );
    expect(screen.getByTestId('provision-declarations-provides').textContent).toBe('\u2014');
    expect(screen.getAllByTestId(DEPENDENCY_ID)).toHaveLength(1);
  });

  it('says so plainly when the manifest declares nothing', () => {
    render(<ProvisionDeclarationsPreview detail={{ manifestDeclarations: { providesScopes: [], dependsOn: [] } }} />);

    expect(screen.getByTestId('provision-declarations-preview').getAttribute('data-state')).toBe('empty');
    expect(screen.getByText('Declares no scopes of its own, no dependencies, and no events it may emit.')).toBeDefined();
    expect(screen.queryByTestId('provision-declarations-provides')).toBeNull();
  });

  it('#2638: shows the event types the app will be allowed to emit, and says they only notify and audit', () => {
    render(
      <ProvisionDeclarationsPreview
        detail={{ manifestDeclarations: { providesScopes: [], dependsOn: [], emittableEvents: ['tip.granted', 'tip.sent'] } }}
      />,
    );

    expect(screen.getByTestId('provision-declarations-preview').getAttribute('data-state')).toBe('declared');
    expect(screen.getByTestId('provision-declarations-emits').textContent).toBe('tip.granted, tip.sent');
    expect(screen.getByTestId('provision-declarations-preview').textContent).toMatch(/notify and audit only/);
  });

  it('#2638: shows a dash for emits when the app declares none, and reads a pre-#2638 snapshot as none', () => {
    render(
      <ProvisionDeclarationsPreview detail={{ manifestDeclarations: { providesScopes: ['dykil:read'], dependsOn: [] } }} />,
    );

    expect(screen.getByTestId('provision-declarations-emits').textContent).toBe('\u2014');
  });

  it.each([
    ['absent (no manifest was readable when the proposal was raised)', { slug: 'dykil' }],
    ['null', { manifestDeclarations: null }],
    ['not an object', { manifestDeclarations: 'dykil:read' }],
    ['missing dependsOn', { manifestDeclarations: { providesScopes: ['dykil:read'] } }],
    ['a malformed dependency', { manifestDeclarations: { providesScopes: [], dependsOn: [{ aud: 'jin.imajin.ai' }] } }],
  ])('says nothing was read, and that approving registers none, when the snapshot is %s', (_label, detail) => {
    render(<ProvisionDeclarationsPreview detail={detail} />);

    const preview = screen.getByTestId('provision-declarations-preview');
    expect(preview.getAttribute('data-state')).toBe('unread');
    expect(preview.textContent).toMatch(/could be read/);
    expect(preview.textContent).toMatch(/registers none/);
    expect(screen.queryByTestId('provision-declarations-provides')).toBeNull();
  });

  it('renders the unread state for a card with no detail at all', () => {
    render(<ProvisionDeclarationsPreview detail={null} />);

    expect(screen.getByTestId('provision-declarations-preview').getAttribute('data-state')).toBe('unread');
  });

  it('renders scope strings as inert text, never as markup', () => {
    render(
      <ProvisionDeclarationsPreview
        detail={{ manifestDeclarations: { providesScopes: ['<img src=x onerror=alert(1)>'], dependsOn: [] } }}
      />,
    );

    expect(screen.getByTestId('provision-declarations-provides').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });
});
