// shim-esm-subpaths.test.mjs — unit tests for scripts/lib/shim-esm-subpaths.mjs
// (#2383).
//
// The bug: `next` ships no `"exports"` field in any published version, so
// plain Node's ESM loader can't resolve a bare subpath specifier like
// `next/server` on its own — only `require()` (CJS) probes the `.js`
// extension for a bare specifier; `import` requires an exact file match.
// `@ima-jin/auth`'s top-level barrel statically (and eagerly)
// `import`s `next/server`, so loading the published package under plain
// Node — exactly what scripts/smoke/sdk-mint-verify.mjs does — always
// fails with "Cannot find module '.../next/server'" regardless of which
// `next` version is installed (reproduced locally against both 15.5.24 and
// 16.3.6). See the module docstring for the full root-cause writeup and why
// a synthetic `"exports"` map isn't the fix.
//
// This file covers the pure logic (subpath extraction, single-shim
// creation, and the end-to-end scan-and-shim orchestration) against a fake
// `node_modules` tree — no real `next` install or network access needed.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureEsmSubpathShim, findPeerSubpathsUsed, shimEsmSubpaths } from '../lib/shim-esm-subpaths.mjs';

describe('findPeerSubpathsUsed (#2383)', () => {
  it('finds a static "from" import', () => {
    const source = 'import { NextResponse } from "next/server";';
    expect(findPeerSubpathsUsed(source, 'next')).toEqual(new Set(['server']));
  });

  it('finds a static "from" import using single quotes', () => {
    const source = "import { NextRequest, NextResponse } from 'next/server';";
    expect(findPeerSubpathsUsed(source, 'next')).toEqual(new Set(['server']));
  });

  it('finds a dynamic import() call (e.g. @ima-jin/auth\'s next/headers usage)', () => {
    const source = 'const { cookies } = await import("next/headers");';
    expect(findPeerSubpathsUsed(source, 'next')).toEqual(new Set(['headers']));
  });

  it('finds a require() call', () => {
    const source = "const { NextResponse } = require('next/server');";
    expect(findPeerSubpathsUsed(source, 'next')).toEqual(new Set(['server']));
  });

  it('collects multiple distinct subpaths from the same source', () => {
    const source = [
      'import { NextResponse } from "next/server";',
      'const { cookies } = await import("next/headers");',
    ].join('\n');
    expect(findPeerSubpathsUsed(source, 'next')).toEqual(new Set(['server', 'headers']));
  });

  it('does not match a different peer name', () => {
    const source = 'import { NextResponse } from "next/server";';
    expect(findPeerSubpathsUsed(source, 'react')).toEqual(new Set());
  });

  it('does not match a deep/internal path (only single-segment subpaths are shimmable)', () => {
    const source = "require('next/dist/server/web/spec-extension/request');";
    expect(findPeerSubpathsUsed(source, 'next')).toEqual(new Set());
  });

  it('returns an empty set when the peer is not referenced at all', () => {
    expect(findPeerSubpathsUsed('export const x = 1;', 'next')).toEqual(new Set());
  });
});

describe('ensureEsmSubpathShim (#2383)', () => {
  it('writes a re-export shim when the source .js file exists and the shim does not', () => {
    const peerDir = mkdtempSync(join(tmpdir(), 'shim-peer-'));
    try {
      writeFileSync(join(peerDir, 'server.js'), 'module.exports = { NextResponse: {} };');

      expect(ensureEsmSubpathShim(peerDir, 'server')).toBe(true);
      expect(readFileSync(join(peerDir, 'server'), 'utf8')).toBe("module.exports = require('./server.js');\n");
    } finally {
      rmSync(peerDir, { recursive: true, force: true });
    }
  });

  it('is idempotent: does nothing if the shim file already exists', () => {
    const peerDir = mkdtempSync(join(tmpdir(), 'shim-peer-'));
    try {
      writeFileSync(join(peerDir, 'server.js'), 'module.exports = {};');
      writeFileSync(join(peerDir, 'server'), 'pre-existing content');

      expect(ensureEsmSubpathShim(peerDir, 'server')).toBe(false);
      expect(readFileSync(join(peerDir, 'server'), 'utf8')).toBe('pre-existing content');
    } finally {
      rmSync(peerDir, { recursive: true, force: true });
    }
  });

  it('does nothing when the source .js file does not exist', () => {
    const peerDir = mkdtempSync(join(tmpdir(), 'shim-peer-'));
    try {
      expect(ensureEsmSubpathShim(peerDir, 'nonexistent')).toBe(false);
    } finally {
      rmSync(peerDir, { recursive: true, force: true });
    }
  });
});

describe('shimEsmSubpaths (#2383)', () => {
  function buildFakeScratchDir() {
    const scratchDir = mkdtempSync(join(tmpdir(), 'shim-scratch-'));
    const nodeModules = join(scratchDir, 'node_modules');

    // A fake peer standing in for `next`: no "exports" field, a real
    // server.js/headers.js pair, and an unrelated internal file that must
    // never get shimmed.
    const peerDir = join(nodeModules, 'next');
    mkdirSync(peerDir, { recursive: true });
    writeFileSync(join(peerDir, 'package.json'), JSON.stringify({ name: 'next', version: '15.5.24' }));
    writeFileSync(join(peerDir, 'server.js'), 'module.exports = { NextResponse: {} };');
    writeFileSync(join(peerDir, 'headers.js'), 'module.exports = { cookies: () => {} };');
    mkdirSync(join(peerDir, 'dist', 'server', 'web', 'spec-extension'), { recursive: true });
    writeFileSync(join(peerDir, 'dist', 'server', 'web', 'spec-extension', 'request.js'), 'module.exports = {};');

    // A fake installed @ima-jin/* package whose compiled output references
    // next/server and next/headers, the same way @ima-jin/auth's dist does.
    const authDir = join(nodeModules, '@ima-jin', 'auth');
    mkdirSync(join(authDir, 'dist'), { recursive: true });
    writeFileSync(
      join(authDir, 'dist', 'index.js'),
      [
        'import { NextResponse } from "next/server";',
        'async function getCookies() { return import("next/headers"); }',
        'export { NextResponse, getCookies };',
      ].join('\n'),
    );

    return { scratchDir, peerDir };
  }

  it('shims every referenced subpath of a peer with no "exports" field', () => {
    const { scratchDir, peerDir } = buildFakeScratchDir();
    try {
      const written = shimEsmSubpaths(scratchDir, ['next']);

      expect(written).toEqual(
        expect.arrayContaining([
          { peerName: 'next', subpath: 'server' },
          { peerName: 'next', subpath: 'headers' },
        ]),
      );
      expect(written).toHaveLength(2);
      expect(readFileSync(join(peerDir, 'server'), 'utf8')).toBe("module.exports = require('./server.js');\n");
      expect(readFileSync(join(peerDir, 'headers'), 'utf8')).toBe("module.exports = require('./headers.js');\n");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('never shims a deep internal peer path even though it exists on disk', () => {
    const { scratchDir, peerDir } = buildFakeScratchDir();
    try {
      shimEsmSubpaths(scratchDir, ['next']);

      expect(
        () => readFileSync(join(peerDir, 'dist', 'server', 'web', 'spec-extension', 'request'), 'utf8'),
      ).toThrow();
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('skips a peer that already declares its own "exports" field', () => {
    const { scratchDir, peerDir } = buildFakeScratchDir();
    try {
      const peerPkgJsonPath = join(peerDir, 'package.json');
      const peerPkgJson = JSON.parse(readFileSync(peerPkgJsonPath, 'utf8'));
      peerPkgJson.exports = { '.': './index.js' };
      writeFileSync(peerPkgJsonPath, JSON.stringify(peerPkgJson));

      expect(shimEsmSubpaths(scratchDir, ['next'])).toEqual([]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('returns an empty list for a peer that was never installed', () => {
    const { scratchDir } = buildFakeScratchDir();
    try {
      expect(shimEsmSubpaths(scratchDir, ['react'])).toEqual([]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('ignores a peer name that would resolve outside node_modules', () => {
    const { scratchDir } = buildFakeScratchDir();
    try {
      expect(shimEsmSubpaths(scratchDir, ['../../etc'])).toEqual([]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
