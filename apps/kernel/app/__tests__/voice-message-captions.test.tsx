// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VoiceMessage } from '../../../../packages/chat/src/VoiceMessage';

afterEach(cleanup);

function renderVoice(transcript: string, durationMs = 3000) {
  return render(
    <VoiceMessage assetId="voice-1" transcript={transcript} durationMs={durationMs} isOwn={false} />,
  );
}

function readCaptionData(container: HTMLElement): string {
  const track = container.querySelector('audio > track');
  expect(track).toBeDefined();
  const source = track?.getAttribute('src') ?? '';
  expect(source).toMatch(/^data:text\/vtt;charset=utf-8,/);
  return decodeURIComponent(source.slice(source.indexOf(',') + 1));
}

describe('voice-message transcript captions (#2862)', () => {
  it.each(['', ' \t\r\n \n'])('offers zero cues without fabricated text for absent transcript %j', transcript => {
    const { container } = renderVoice(transcript);
    expect(readCaptionData(container)).toBe('WEBVTT\n\n');
    expect(container.querySelector('audio > track')?.hasAttribute('default')).toBe(false);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDefined();
  });

  it('provides meaningful escaped captions without claiming a known language', () => {
    const transcript = '<b>Hello & welcome</b>\r\n\r\n  \r\nNext --> <00:00:01.000>\rLast line';
    const { container } = renderVoice(transcript, 4567);
    const track = container.querySelector('audio > track');

    expect(track?.getAttribute('kind')).toBe('captions');
    expect(track?.getAttribute('srclang')).toBe('und');
    expect(track?.getAttribute('label')).toBe('Transcript');
    expect(track?.hasAttribute('default')).toBe(true);
    expect(readCaptionData(container)).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:04.567\n'
      + '&lt;b&gt;Hello &amp; welcome&lt;/b&gt;\nNext --&gt; &lt;00:00:01.000&gt;\nLast line\n',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    expect(container.querySelector('p')?.textContent).toBe(transcript);
  });

  it.each([
    [0, '00:00:00.001'],
    [-10, '00:00:00.001'],
    [0.5, '00:00:00.001'],
    [999, '00:00:00.999'],
    [1000, '00:00:01.000'],
    [60000, '00:01:00.000'],
    [3600000, '01:00:00.000'],
    [3661007, '01:01:01.007'],
    [360000000, '100:00:00.000'],
    [Number.NaN, '00:00:00.001'],
    [Number.POSITIVE_INFINITY, '00:00:00.001'],
  ])('covers duration %s with a valid end timestamp %s', (duration, end) => {
    const { container } = renderVoice('Entire recording', duration);
    expect(readCaptionData(container)).toBe(
      `WEBVTT\n\n00:00:00.000 --> ${end}\nEntire recording\n`,
    );
  });

  it('updates captions when the transcript or duration metadata changes', () => {
    const { container, rerender } = renderVoice('');
    const track = container.querySelector('audio > track');
    expect(readCaptionData(container)).toBe('WEBVTT\n\n');
    rerender(
      <VoiceMessage assetId="voice-1" transcript="Updated transcript" durationMs={9000} isOwn={false} />,
    );
    expect(container.querySelector('audio > track')).toBe(track);
    expect(track?.hasAttribute('default')).toBe(true);
    expect(readCaptionData(container)).toContain('00:00:09.000\nUpdated transcript');
    rerender(
      <VoiceMessage assetId="voice-1" transcript="" durationMs={9000} isOwn={false} />,
    );
    expect(container.querySelector('audio > track')).toBe(track);
    expect(track?.hasAttribute('default')).toBe(false);
    expect(readCaptionData(container)).toBe('WEBVTT\n\n');
  });
});
