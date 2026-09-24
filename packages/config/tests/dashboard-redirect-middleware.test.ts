import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { standaloneDashboardMiddleware } from '../src/dashboard-redirect-middleware';

const ENV_KEYS = ['NEXT_PUBLIC_SERVICE_PREFIX', 'NEXT_PUBLIC_DOMAIN'] as const;

describe('standaloneDashboardMiddleware', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.NEXT_PUBLIC_SERVICE_PREFIX = 'jin.imajin.ai/';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('308-redirects the standalone /dashboard route to the given service\'s hub tab, preserving the query string', () => {
    const res = standaloneDashboardMiddleware(
      new NextRequest('https://jin.imajin.ai/dashboard?foo=bar'),
      { service: 'events' },
    );

    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://jin.imajin.ai/auth/events?foo=bar');
  });

  it('builds the hub URL for whatever service is passed', () => {
    const res = standaloneDashboardMiddleware(new NextRequest('https://jin.imajin.ai/dashboard'), {
      service: 'dykil',
    });

    expect(res.headers.get('location')).toBe('https://jin.imajin.ai/auth/dykil');
  });

  it('drops the query string entirely when the standalone request had none', () => {
    const res = standaloneDashboardMiddleware(new NextRequest('https://jin.imajin.ai/dashboard'), {
      service: 'market',
    });

    expect(res.headers.get('location')).toBe('https://jin.imajin.ai/auth/market');
  });

  it('redirects /dashboard even when cors is disabled', () => {
    const res = standaloneDashboardMiddleware(new NextRequest('https://jin.imajin.ai/dashboard'), {
      service: 'links',
      cors: false,
    });

    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://jin.imajin.ai/auth/links');
  });

  it('answers a CORS pre-flight OPTIONS request for a non-dashboard path when cors defaults to enabled', () => {
    const req = new NextRequest('https://jin.imajin.ai/api/whatever', {
      method: 'OPTIONS',
      headers: { origin: 'https://jin.imajin.ai' },
    });

    const res = standaloneDashboardMiddleware(req, { service: 'coffee' });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://jin.imajin.ai');
  });

  it('stamps CORS headers on a pass-through response for a non-OPTIONS, non-dashboard request', () => {
    const req = new NextRequest('https://jin.imajin.ai/api/whatever', {
      headers: { origin: 'https://jin.imajin.ai' },
    });

    const res = standaloneDashboardMiddleware(req, { service: 'learn' });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://jin.imajin.ai');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('skips CORS entirely (even for OPTIONS) when cors is explicitly disabled', () => {
    const req = new NextRequest('https://jin.imajin.ai/anything', {
      method: 'OPTIONS',
      headers: { origin: 'https://jin.imajin.ai' },
    });

    const res = standaloneDashboardMiddleware(req, { service: 'dykil', cors: false });

    expect(res.status).not.toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
