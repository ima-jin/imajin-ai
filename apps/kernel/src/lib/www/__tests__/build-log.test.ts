import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadFileSync = vi.hoisted(() => vi.fn<(path: string, encoding: string) => string>());

vi.mock('node:fs', () => ({ default: { readFileSync: mockReadFileSync } }));

import { getBuildEntries } from '../build-log';

describe('getBuildEntries', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  it('renders one entry per H2 section, in file order, splitting date from title', async () => {
    mockReadFileSync.mockReturnValue(
      [
        '# Build log',
        '',
        '## 2026-10-03 — Third',
        '',
        'Some **bold** text',
        '',
        '## 2026-10-02 — Second',
        '',
        '- item one',
        '- item two',
        '',
        '## 2026-10-01',
        '',
        'No title here',
        '',
      ].join('\r\n'),
    );

    const entries = await getBuildEntries();

    expect(entries.map((e) => [e.date, e.title])).toEqual([
      ['2026-10-03', 'Third'],
      ['2026-10-02', 'Second'],
      ['2026-10-01', ''],
    ]);
    expect(entries[0].contentHtml).toContain('<strong>bold</strong>');
    expect(entries[1].contentHtml).toContain('<li>item one</li>');
    expect(entries[2].contentHtml).toContain('No title here');
  });

  it('returns no entries when the log has no H2 sections', async () => {
    mockReadFileSync.mockReturnValue('# Build log\n\nJust a preamble.\n');

    await expect(getBuildEntries()).resolves.toEqual([]);
  });
});
