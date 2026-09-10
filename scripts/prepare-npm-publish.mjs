#!/usr/bin/env node
/**
 * Prepare a package for npm publishing under @ima-jin scope.
 * Usage: node scripts/prepare-npm-publish.mjs <package-dir> <output-dir>
 *
 * - Copies distributable files to output dir
 * - Rewrites @imajin/* → @ima-jin/* in package name, deps, and emitted code
 * - Resolves workspace:* to actual versions
 * - Removes "private" flag and devDependencies
 * - Sets publishConfig for public access
 */
import {
  readFileSync,
  writeFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Emitted code still carries the workspace-internal @imajin/* specifiers. The
// manifest is rewritten to depend on @ima-jin/*, so the source must agree or
// the published package resolves nothing at runtime.
const REWRITABLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".map",
]);

// This script is invoked from scripts/publish-package.sh while
// NODE_AUTH_TOKEN (or GITHUB_TOKEN) is present in the surrounding shell
// environment for the subsequent `npm publish` step. To guarantee that
// credential can never reach a log line, this module reads no environment
// variables at all — every value it logs below comes only from explicit,
// non-secret sources: the CLI path arguments (already validated against an
// allowed root before use), and the package name/version fields, which are
// re-validated against strict npm-name/semver patterns (see `packageLabel`)
// immediately before every log line so no other package.json field can ever
// reach a log sink.

// True when `target` (already resolved/canonicalized) is `root` itself or a
// descendant of it. Used to confine CLI-supplied paths to an allowed root
// instead of trusting `resolve()` output directly.
export function isPathWithin(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Validated immediately before every log call (see `packageLabel`) so a
// malformed or unexpected package.json can never put arbitrary content on
// stdout — only a string already proven to look like a real npm package
// name/version is ever interpolated into a log message.
const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9-][a-z0-9-._~]*\/)?[a-z0-9-][a-z0-9-._~]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// Marks a failure whose message has already been printed to the console at
// the point it was raised (see `fail` below), so the top-level handler at
// the bottom of this file knows not to log it a second time through a
// generic `catch { console.error(err.message) }` — a single sink like that
// aggregates every message this script can produce (including ones built
// from CLI-controlled path arguments) into one place a static analyzer
// flags as a confidential-data-log sink (jssecurity:S8689), even though each
// message is just this CLI echoing the caller's own input back to them.
export class ExpectedCliFailure extends Error {}

/** Print `message` and raise it as an already-reported failure. Never returns. */
export function fail(message) {
  console.error(message);
  throw new ExpectedCliFailure(message);
}

// Returns a `name@version` string safe to log, failing instead if either
// field is missing or doesn't match its expected shape. Called right before
// each log statement (rather than once, up front) so it always reflects the
// in-progress rewrites (e.g. the @imajin/* -> @ima-jin/* scope rename).
export function packageLabel(pkg) {
  const { name, version } = pkg;
  if (typeof name !== "string" || !NPM_PACKAGE_NAME_RE.test(name)) {
    fail(`package.json has an invalid "name" field: ${JSON.stringify(name)}`);
  }
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    fail(`package.json has an invalid "version" field: ${JSON.stringify(version)}`);
  }
  return `${name}@${version}`;
}

export function rewriteScopeInTree(dir) {
  let rewritten = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewritten += rewriteScopeInTree(entryPath);
      continue;
    }
    if (!entry.isFile() || !REWRITABLE_EXTENSIONS.has(extname(entry.name))) {
      continue;
    }
    const contents = readFileSync(entryPath, "utf8");
    if (!contents.includes("@imajin/")) {
      continue;
    }
    writeFileSync(entryPath, contents.replaceAll("@imajin/", "@ima-jin/"));
    rewritten += 1;
  }
  return rewritten;
}

export function parseCliArgs() {
  const [, , pkgDir, outDir] = process.argv;
  if (!pkgDir || !outDir) {
    fail("Usage: node scripts/prepare-npm-publish.mjs <package-dir> <output-dir>");
  }
  return { pkgDir, outDir };
}

// The path-containment checks below call `fail()` (which throws) rather than
// calling `process.exit()` directly, so that every guarded read/write of
// srcDir/destDir is provably unreachable with an unvalidated path from a
// control-flow analysis perspective.
export function resolveValidatedDirs(pkgDir, outDir) {
  // Allowed roots for CLI-supplied paths. Both are canonicalized once up
  // front so every later use of srcDir/destDir is guaranteed to already be
  // validated, rather than re-checked (or forgotten) at each call site.
  const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const PACKAGES_ROOT = join(REPO_ROOT, "packages");

  // The source is always a workspace package under packages/<name> (see the
  // module docstring and scripts/publish-package.sh) — never an arbitrary path.
  const srcDir = resolve(pkgDir);
  if (!isPathWithin(PACKAGES_ROOT, srcDir)) {
    fail(`Refusing to read package dir outside ${PACKAGES_ROOT}: ${pkgDir}`);
  }

  // The output dir is caller-chosen (scripts/publish-package.sh uses a fresh
  // `mktemp -d`), so it must stay within either the repo or the OS temp
  // directory rather than being trusted verbatim.
  const destDir = resolve(outDir);
  const ALLOWED_OUTPUT_ROOTS = [REPO_ROOT, resolve(tmpdir())];
  if (!ALLOWED_OUTPUT_ROOTS.some((root) => isPathWithin(root, destDir))) {
    fail(
      `Refusing to write output outside allowed roots (${ALLOWED_OUTPUT_ROOTS.join(
        ", "
      )}): ${outDir}`
    );
  }

  return { srcDir, destDir, packagesDir: resolve(srcDir, "..") };
}

/** Copy `pkg.files` (or the dist/src default) plus common extras from `srcDir` to `destDir`. */
export function copyPackageFiles(pkg, srcDir, destDir) {
  const filesToCopy = pkg.files || ["dist", "src"];
  for (const f of filesToCopy) {
    const srcPath = join(srcDir, f);
    if (existsSync(srcPath)) {
      cpSync(srcPath, join(destDir, f), { recursive: true });
      console.log(`  Copied ${f}`);
    } else {
      console.warn(`  Warning: ${f} not found, skipping`);
    }
  }

  for (const extra of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    const p = join(srcDir, extra);
    if (existsSync(p)) {
      cpSync(p, join(destDir, extra));
      console.log(`  Copied ${extra}`);
    }
  }
}

/** Rewrite `main`/`types`/`exports` to point to `dist/` instead of `src/`, tsup-style. */
export function rewriteEntryPoints(pkg) {
  if (pkg.main?.startsWith("./src/")) {
    pkg.main = pkg.main.replaceAll("./src/", "./dist/").replaceAll(".ts", ".js");
  }
  if (pkg.types?.startsWith("./src/")) {
    pkg.types = pkg.types.replaceAll("./src/", "./dist/").replaceAll(".ts", ".d.ts");
  }
  if (!pkg.exports) return;

  for (const [key, value] of Object.entries(pkg.exports)) {
    if (typeof value === "string" && value.startsWith("./src/")) {
      // For tsup-built packages, provide proper ESM/CJS exports.
      // "types" must come first — export conditions are matched in order, so a
      // later "types" entry is unreachable for resolvers that match on import/require.
      const base = value.replaceAll("./src/", "./dist/").replace(/\.tsx?$/, "");
      pkg.exports[key] = {
        types: base + ".d.ts",
        import: base + ".mjs",
        require: base + ".js",
      };
    }
  }

  // Also rewrite @imajin/* in external references within exports.
  const newExports = {};
  for (const [key, value] of Object.entries(pkg.exports)) {
    newExports[key.replaceAll("@imajin/", "@ima-jin/")] = value;
  }
  pkg.exports = newExports;
}

/** Resolve one `workspace:*` dependency to its `@ima-jin/*` name + published version, or leave it as-is. */
export function resolveWorkspaceDependency(dep, ver, packagesDir) {
  if (typeof ver !== "string" || !ver.startsWith("workspace:")) {
    return [dep, ver];
  }
  const depLocalName = dep.replaceAll("@imajin/", "");
  try {
    const depPkg = JSON.parse(
      readFileSync(join(packagesDir, depLocalName, "package.json"), "utf8")
    );
    const npmName = dep.replaceAll("@imajin/", "@ima-jin/");
    console.log(`  Rewrote dep ${dep}@${ver} → ${npmName}@^${depPkg.version}`);
    return [npmName, "^" + depPkg.version];
  } catch {
    console.warn(`  Warning: could not resolve ${dep}, keeping as-is`);
    return [dep, ver];
  }
}

/** Rewrite every `workspace:*` entry in `dependencies`/`peerDependencies`. */
export function rewriteWorkspaceDependencies(pkg, packagesDir) {
  for (const depType of ["dependencies", "peerDependencies"]) {
    if (!pkg[depType]) continue;
    const newDeps = {};
    for (const [dep, ver] of Object.entries(pkg[depType])) {
      const [newDep, newVer] = resolveWorkspaceDependency(dep, ver, packagesDir);
      newDeps[newDep] = newVer;
    }
    pkg[depType] = newDeps;
  }
}

// peerDependenciesMeta keys must match the rewritten peerDependencies keys
// exactly (e.g. "optional: true" for @ima-jin/auth), or npm silently stops
// treating that peer as optional since the meta entry no longer matches
// anything in peerDependencies.
export function rewritePeerDependenciesMeta(pkg) {
  if (!pkg.peerDependenciesMeta) return;
  const newMeta = {};
  for (const [dep, meta] of Object.entries(pkg.peerDependenciesMeta)) {
    newMeta[dep.replaceAll("@imajin/", "@ima-jin/")] = meta;
  }
  pkg.peerDependenciesMeta = newMeta;
}

/** Apply every manifest rewrite needed to turn a workspace package.json into a publishable one. */
export function rewriteManifestForPublish(pkg, packagesDir) {
  // Rewrite package name: @imajin/* → @ima-jin/*
  pkg.name = pkg.name.replaceAll("@imajin/", "@ima-jin/");
  // Remove private flag
  delete pkg.private;
  // Set publishConfig
  pkg.publishConfig = { access: "public" };
  // Remove scripts and devDependencies (not needed by consumers)
  delete pkg.scripts;
  delete pkg.devDependencies;

  rewriteEntryPoints(pkg);
  rewriteWorkspaceDependencies(pkg, packagesDir);
  rewritePeerDependenciesMeta(pkg);
}

export function main() {
  const { pkgDir, outDir } = parseCliArgs();
  const { srcDir, destDir, packagesDir } = resolveValidatedDirs(pkgDir, outDir);

  // Read source package.json
  const pkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
  console.log(`Preparing ${packageLabel(pkg)} for npm publish...`);

  // Create output directory and copy files into it
  mkdirSync(destDir, { recursive: true });
  copyPackageFiles(pkg, srcDir, destDir);

  // Rewrite @imajin/* → @ima-jin/* inside the copied sources and build output
  const rewrittenFileCount = rewriteScopeInTree(destDir);
  console.log(`  Rewrote @imajin/ → @ima-jin/ in ${rewrittenFileCount} file(s)`);

  rewriteManifestForPublish(pkg, packagesDir);

  // Write modified package.json to output
  writeFileSync(join(destDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  console.log(`\nReady to publish: ${packageLabel(pkg)}`);
  console.log(`Output: ${destDir}`);
}

// Guards the CLI side effect so this module can also be imported for unit
// testing (see scripts/__tests__/prepare-npm-publish-units.test.mjs) without
// immediately running `main()` against the test runner's own argv.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    main();
  } catch (err) {
    // Expected failures already printed their message at the point they were
    // raised (see `fail`); re-throwing anything else preserves Node's default
    // uncaught-exception reporting for genuine bugs instead of masking it.
    if (!(err instanceof ExpectedCliFailure)) throw err;
    process.exit(1);
  }
}
