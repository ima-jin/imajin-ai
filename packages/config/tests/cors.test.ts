import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
  corsHeaders,
  corsOptions,
  isAllowedOrigin,
  validateOrigin,
  withCors,
} from '../src/cors';

function makeReq(origin?: string): NextRequest {
  const headers = new Headers();
  if (origin !== undefined) {
    headers.set('origin', origin);
  }
  return { headers } as unknown as NextRequest;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('isAllowedOrigin', () => {
  it.each([
    'https://jin.imajin.ai',
    'https://dev-jin.imajin.ai',
  ])('allows the imajin origin %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  it.each([
    ['a missing origin', null],
    ['a look-alike domain', 'https://imajin.ai.evil.com'],
    ['plain http on the real domain', 'http://jin.imajin.ai'],
  ])('rejects %s', (_label, origin) => {
    expect(isAllowedOrigin(origin)).toBe(false);
  });

  it('allows localhost only outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);

    process.env.NODE_ENV = 'production';
    expect(isAllowedOrigin('http://localhost:3000')).toBe(false);
  });
});

describe('corsHeaders', () => {
  /**
   * App-auth callers (#1540) send their consent headers on cross-origin
   * requests. Dropping either name here fails pre-flight in the browser, so the
   * app-facing connector surface is only reachable server-side.
   */
  it('permits the app-auth consent headers', () => {
    const allowedHeaders = corsHeaders(makeReq('https://jin.imajin.ai'))['Access-Control-Allow-Headers'];

    expect(allowedHeaders).toContain('X-App-DID');
    expect(allowedHeaders).toContain('X-App-Authorization');
    expect(allowedHeaders).toContain('Authorization');
    expect(allowedHeaders).toContain('Content-Type');
  });

  it('echoes an allowed origin and varies on it', () => {
    const headers = corsHeaders(makeReq('https://jin.imajin.ai'));

    expect(headers['Access-Control-Allow-Origin']).toBe('https://jin.imajin.ai');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(headers['Vary']).toBe('Origin');
  });

  it('blanks the allowed origin for a disallowed caller', () => {
    expect(corsHeaders(makeReq('https://evil.example'))['Access-Control-Allow-Origin']).toBe('');
  });
});

describe('corsOptions', () => {
  it('answers pre-flight with 204 and the CORS headers', () => {
    const res = corsOptions(makeReq('https://jin.imajin.ai'));

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://jin.imajin.ai');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-App-DID');
  });
});

describe('withCors', () => {
  it('copies the CORS headers onto an existing response', () => {
    const res = withCors(NextResponse.json({ ok: true }), makeReq('https://jin.imajin.ai'));

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://jin.imajin.ai');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});

describe('validateOrigin', () => {
  it('allows server-side calls that send no origin header', () => {
    expect(validateOrigin(makeReq())).toBe(true);
  });

  it('gates browser calls on the allow-list', () => {
    expect(validateOrigin(makeReq('https://jin.imajin.ai'))).toBe(true);
    expect(validateOrigin(makeReq('https://evil.example'))).toBe(false);
  });
});
