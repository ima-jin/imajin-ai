import { describe, expect, it } from 'vitest';
import { stripTrailingSlashes, toWebSocketUrl } from '../src/url-utils.js';

describe('stripTrailingSlashes', () => {
  it('strips one or more trailing slashes', () => {
    expect(stripTrailingSlashes('https://kernel.example.com/')).toBe('https://kernel.example.com');
    expect(stripTrailingSlashes('https://kernel.example.com///')).toBe('https://kernel.example.com');
  });

  it('leaves a URL with no trailing slash unchanged', () => {
    expect(stripTrailingSlashes('https://kernel.example.com')).toBe('https://kernel.example.com');
  });
});

describe('toWebSocketUrl', () => {
  it('swaps https for wss', () => {
    expect(toWebSocketUrl('https://kernel.example.com/')).toBe('wss://kernel.example.com');
  });

  it('swaps http for ws', () => {
    expect(toWebSocketUrl('http://127.0.0.1:3000')).toBe('ws://127.0.0.1:3000');
  });

  it('leaves a non-http(s) scheme unchanged', () => {
    expect(toWebSocketUrl('ws://already-ws.example.com')).toBe('ws://already-ws.example.com');
  });
});
