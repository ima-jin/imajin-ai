#!/usr/bin/env node
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Run the exact runtime classifier, not a permissive regex approximation. */
export function loadClassifier(repository = root) {
  const filename = resolve(repository, 'apps/kernel/src/lib/cloudflare/classification-source.ts');
  const require = createRequire(resolve(repository, 'apps/kernel/package.json'));
  const ts = require('typescript');
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename, reportDiagnostics: true,
  });
  const errors = output.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => repository, getNewLine: () => '\n',
  }));
  // A distinct virtual filename avoids merging CJS byte offsets with the
  // original TS module's V8 coverage when the guard is exercised by Vitest.
  const compiledFilename = `${filename}.guard.cjs`;
  const module = new Module(compiledFilename);
  module.filename = compiledFilename;
  module.paths = Module._nodeModulePaths(dirname(filename));
  module._compile(output.outputText, compiledFilename);
  return module.exports;
}

export function checkEdgeClasses(kernel = resolve(root, 'apps/kernel')) {
  const { scanKernelRoutes } = loadClassifier();
  const routes = scanKernelRoutes(kernel);
  const failures = routes.filter(route => route.class === 'unclassified' || !route.reason.trim());
  return { routes, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { routes, failures } = checkEdgeClasses(process.argv[2] ? resolve(process.argv[2]) : undefined);
  for (const route of failures) console.error(`${route.source}: ${route.method} ${route.path}: ${route.reason}`);
  console.log(`Edge classification: ${routes.length} derived operations/assets, ${failures.length} unresolved`);
  process.exitCode = failures.length ? 1 : 0;
}
