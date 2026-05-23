#!/usr/bin/env node
/**
 * Prepare a package for npm publishing under @ima-jin scope.
 * Usage: node scripts/prepare-npm-publish.mjs <package-dir> <output-dir>
 *
 * - Copies distributable files to output dir
 * - Rewrites @imajin/* → @ima-jin/* in package name and deps
 * - Resolves workspace:* to actual versions
 * - Removes "private" flag and devDependencies
 * - Sets publishConfig for public access
 */
import { readFileSync, writeFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const [, , pkgDir, outDir] = process.argv;
if (!pkgDir || !outDir) {
  console.error(
    "Usage: node scripts/prepare-npm-publish.mjs <package-dir> <output-dir>"
  );
  process.exit(1);
}

const srcDir = resolve(pkgDir);
const destDir = resolve(outDir);
const packagesDir = resolve(srcDir, "..");

// Read source package.json
const pkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));

console.log(`Preparing ${pkg.name}@${pkg.version} for npm publish...`);

// Create output directory
mkdirSync(destDir, { recursive: true });

// Copy files listed in "files" field, plus common extras
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

// Copy extra files if they exist
for (const extra of ["README.md", "LICENSE", "CHANGELOG.md"]) {
  const p = join(srcDir, extra);
  if (existsSync(p)) {
    cpSync(p, join(destDir, extra));
    console.log(`  Copied ${extra}`);
  }
}

// Rewrite package name: @imajin/* → @ima-jin/*
const originalName = pkg.name;
pkg.name = pkg.name.replaceAll("@imajin/", "@ima-jin/");

// Remove private flag
delete pkg.private;

// Set publishConfig
pkg.publishConfig = { access: "public" };

// Remove scripts (not needed by consumers)
delete pkg.scripts;

// Remove devDependencies (not needed by consumers)
delete pkg.devDependencies;

// Rewrite exports/main/types to point to dist/ instead of src/
if (pkg.main && pkg.main.startsWith("./src/")) {
  pkg.main = pkg.main.replaceAll("./src/", "./dist/").replaceAll(".ts", ".js");
}
if (pkg.types && pkg.types.startsWith("./src/")) {
  pkg.types = pkg.types.replaceAll("./src/", "./dist/").replaceAll(".ts", ".d.ts");
}
if (pkg.exports) {
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (typeof value === "string" && value.startsWith("./src/")) {
      // For tsup-built packages, provide proper ESM/CJS exports
      const base = value.replaceAll("./src/", "./dist/").replace(/\.tsx?$/, "");
      pkg.exports[key] = {
        import: base + ".mjs",
        require: base + ".js",
        types: base + ".d.ts",
      };
    }
  }
}
// Also rewrite @imajin/* in external references within exports
if (pkg.exports) {
  const newExports = {};
  for (const [key, value] of Object.entries(pkg.exports)) {
    const newKey = key.replaceAll("@imajin/", "@ima-jin/");
    newExports[newKey] = value;
  }
  pkg.exports = newExports;
}

// Rewrite workspace:* dependencies
for (const depType of ["dependencies", "peerDependencies"]) {
  if (!pkg[depType]) continue;
  const newDeps = {};
  for (const [dep, ver] of Object.entries(pkg[depType])) {
    if (typeof ver === "string" && ver.startsWith("workspace:")) {
      // Resolve to @ima-jin scope and actual version
      const depLocalName = dep.replaceAll("@imajin/", "");
      try {
        const depPkg = JSON.parse(
          readFileSync(
            join(packagesDir, depLocalName, "package.json"),
            "utf8"
          )
        );
        const npmName = dep.replaceAll("@imajin/", "@ima-jin/");
        newDeps[npmName] = "^" + depPkg.version;
        console.log(`  Rewrote dep ${dep}@${ver} → ${npmName}@^${depPkg.version}`);
      } catch {
        console.warn(`  Warning: could not resolve ${dep}, keeping as-is`);
        newDeps[dep] = ver;
      }
    } else {
      newDeps[dep] = ver;
    }
  }
  pkg[depType] = newDeps;
}

// Write modified package.json to output
writeFileSync(join(destDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

console.log(`\nReady to publish: ${pkg.name}@${pkg.version}`);
console.log(`Output: ${destDir}`);
