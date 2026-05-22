#!/usr/bin/env node
import fs from 'node:fs';
import cp from 'node:child_process';

const mode = process.argv[2] || 'all';
const validModes = new Set(['all', 'node-imports', 'number-api', 'remaining']);
if (!validModes.has(mode)) {
  console.error(`Invalid mode: ${mode}`);
  console.error('Usage: node scripts/sonar/phase17-common-rules-pass.mjs [all|node-imports|number-api|remaining]');
  process.exit(1);
}

const files = cp
  .execSync('git ls-files', { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p));

const stats = {
  mode,
  filesChanged: 0,
  importNodeProtocol: 0,
  numberParseInt: 0,
  numberIsNaN: 0,
  replaceAll: 0,
  someToIncludes: 0,
  atIndex: 0,
};

for (const file of files) {
  let src = fs.readFileSync(file, 'utf8');
  const original = src;

  if (mode === 'all' || mode === 'node-imports') {
    src = src.replace(/(\bfrom\s+['"])fs\/promises(['"])/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:fs/promises${b}`;
    });
    src = src.replace(/(\brequire\(\s*['"])fs\/promises(['"]\s*\))/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:fs/promises${b}`;
    });
    src = src.replace(/(\bimport\(\s*['"])fs\/promises(['"]\s*\))/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:fs/promises${b}`;
    });

    src = src.replace(/(\bfrom\s+['"])fs(['"])/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:fs${b}`;
    });
    src = src.replace(/(\brequire\(\s*['"])fs(['"]\s*\))/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:fs${b}`;
    });
    src = src.replace(/(\bimport\(\s*['"])fs(['"]\s*\))/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:fs${b}`;
    });

    src = src.replace(/(\bfrom\s+['"])path(['"])/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:path${b}`;
    });
    src = src.replace(/(\brequire\(\s*['"])path(['"]\s*\))/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:path${b}`;
    });
    src = src.replace(/(\bimport\(\s*['"])path(['"]\s*\))/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:path${b}`;
    });

    src = src.replace(/(\bfrom\s+['"])crypto(['"])/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:crypto${b}`;
    });
    src = src.replace(/(\brequire\(\s*['"])crypto(['"]\s*\))/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:crypto${b}`;
    });
    src = src.replace(/(\bimport\(\s*['"])crypto(['"]\s*\))/g, (_m, a, b) => {
      stats.importNodeProtocol += 1;
      return `${a}node:crypto${b}`;
    });
  }

  if (mode === 'all' || mode === 'number-api') {
    src = src.replace(/(^|[^\w$.])parseInt\(/g, (_m, p1) => {
      stats.numberParseInt += 1;
      return `${p1}Number.parseInt(`;
    });
    src = src.replace(/(^|[^\w$.])isNaN\(/g, (_m, p1) => {
      stats.numberIsNaN += 1;
      return `${p1}Number.isNaN(`;
    });
  }

  if (mode === 'all' || mode === 'remaining') {
    // Prefer replaceAll when first arg is a simple string literal.
    src = src.replace(/\.replace\(\s*(['"])[^'"\\\n]*(?:\\.[^'"\\\n]*)*\1\s*,/g, (m) => {
      stats.replaceAll += 1;
      return m.replace('.replace(', '.replaceAll(');
    });

    // Use includes() over some() for direct equality checks.
    src = src.replace(
      /(\b[A-Za-z_$][\w$.[\]()]+)\.some\(\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*\2\s*===\s*([^)]+?)\s*\)/g,
      (_m, arr, _item, rhs) => {
        stats.someToIncludes += 1;
        return `${arr}.includes(${rhs.trim()})`;
      }
    );
    src = src.replace(
      /(\b[A-Za-z_$][\w$.[\]()]+)\.some\(\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*([^)]+?)\s*===\s*\2\s*\)/g,
      (_m, arr, _item, lhs) => {
        stats.someToIncludes += 1;
        return `${arr}.includes(${lhs.trim()})`;
      }
    );

    // Prefer at() over [length - index] for simple identifiers.
    src = src.replace(/\b([A-Za-z_$][\w$]*)\s*\[\s*\1\.length\s*-\s*(\d+)\s*\]/g, (_m, arr, n) => {
      stats.atIndex += 1;
      return `${arr}.at(-${n})`;
    });
  }

  if (src !== original) {
    fs.writeFileSync(file, src, 'utf8');
    stats.filesChanged += 1;
  }
}

console.log(JSON.stringify(stats, null, 2));
