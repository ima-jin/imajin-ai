import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...", which
// node then resolves against the cwd into "C:\D:\..." and cannot load.
const SCRIPT = fileURLToPath(new URL('../ci-guard-dist-react-binding.mjs', import.meta.url));

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dist-react-guard-'));
  return dir;
}

function writeDistFile(dir, pkgName, relPath, content) {
  const full = join(dir, 'packages', pkgName, 'dist', relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function runGuard(dir) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, CI_GUARD_WORKDIR: dir },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    };
  }
}

function expectPass(dir) {
  const result = runGuard(dir);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('PASS');
}

function expectFail(dir, ...expectedSubstrings) {
  const result = runGuard(dir);
  const output = result.stdout + result.stderr;
  expect(result.status).toBe(1);
  expect(output).toContain('FAIL');
  for (const substring of expectedSubstrings) {
    expect(output).toContain(substring);
  }
  return output;
}

describe('ci-guard-dist-react-binding', () => {
  it('passes on an empty repo (no packages/*/dist directories at all)', () => {
    const dir = makeTempRepo();
    expectPass(dir);
  });

  it('passes when React.createElement is used and the file has its own `import React from "react"`', () => {
    const dir = makeTempRepo();
    writeDistFile(
      dir,
      'media',
      'index.js',
      'import React from "react";\n' +
        'function AssetCard() { return React.createElement("div", null, "hi"); }\n' +
        'export { AssetCard };\n',
    );
    expectPass(dir);
  });

  it('passes when the automatic JSX runtime is used (jsx()/jsxs() from react/jsx-runtime)', () => {
    const dir = makeTempRepo();
    writeDistFile(
      dir,
      'input',
      'index.js',
      'import { jsx } from "react/jsx-runtime";\n' +
        'function VoiceRecorder() { return jsx("button", { children: "record" }); }\n' +
        'export { VoiceRecorder };\n',
    );
    expectPass(dir);
  });

  it('passes when a renamed React import backs a renamed React.createElement call (e.g. React2)', () => {
    const dir = makeTempRepo();
    writeDistFile(
      dir,
      'input',
      'index.js',
      'import React2 from "react";\n' +
        'function EmojiPicker() { return React2.createElement("div", null); }\n' +
        'export { EmojiPicker };\n',
    );
    expectPass(dir);
  });

  it('fails on the #2401 regression shape: bare React.createElement with no React import in the file', () => {
    const dir = makeTempRepo();
    writeDistFile(
      dir,
      'input',
      'index.js',
      '"use client";\n' +
        'import { useState } from "react";\n' +
        'function VoiceRecorder() {\n' +
        '  const [state] = useState("idle");\n' +
        '  return React.createElement("button", null, "record");\n' +
        '}\n' +
        'export { VoiceRecorder };\n',
    );
    expectFail(dir, 'packages/input/dist/index.js');
  });

  it('fails on a bare React.Fragment reference with no binding', () => {
    const dir = makeTempRepo();
    writeDistFile(
      dir,
      'input',
      'index.cjs',
      'function VoiceRecorder() {\n' +
        '  return React.createElement(React.Fragment, null, "hi");\n' +
        '}\n' +
        'module.exports = { VoiceRecorder };\n',
    );
    expectFail(dir, 'packages/input/dist/index.cjs');
  });

  it('does not flag a CJS bundle where the classic pragma call is against a renamed import_react binding', () => {
    const dir = makeTempRepo();
    writeDistFile(
      dir,
      'media',
      'index.cjs',
      'var import_react = require("react");\n' +
        'function AssetCard() { return import_react.default.createElement("div", null); }\n' +
        'module.exports = { AssetCard };\n',
    );
    expectPass(dir);
  });

  it('ignores sourcemap and declaration files even if they mention React.createElement', () => {
    const dir = makeTempRepo();
    writeDistFile(dir, 'input', 'index.js.map', '{"sources":["VoiceRecorder.tsx"],"sourcesContent":["React.createElement(\'div\')"]}');
    writeDistFile(dir, 'input', 'index.d.ts', '// React.createElement reference in a comment, not real JS\n');
    expectPass(dir);
  });

  it('reports every offending package, not just the first', () => {
    const dir = makeTempRepo();
    writeDistFile(dir, 'input', 'index.js', 'function A() { return React.createElement("div"); }\nexport { A };\n');
    writeDistFile(dir, 'media', 'index.js', 'function B() { return React.createElement("span"); }\nexport { B };\n');

    const output = expectFail(dir, 'packages/input/dist/index.js', 'packages/media/dist/index.js');
    expect(output).toContain('2 dist file(s)');
  });
});
