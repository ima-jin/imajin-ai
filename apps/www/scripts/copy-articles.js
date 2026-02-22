#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Find articles directory
const possiblePaths = [
  path.join(process.cwd(), '../../articles'),
  path.join(process.cwd(), '../../../articles'),
  '/vercel/path0/articles',
  path.join(__dirname, '../../../articles'),
];

console.log('CWD:', process.cwd());
console.log('__dirname:', __dirname);
console.log('Contents of CWD:', fs.readdirSync(process.cwd()));

let articlesDir = null;
for (const p of possiblePaths) {
  console.log('Checking:', p, '- exists:', fs.existsSync(p));
  if (fs.existsSync(p)) {
    articlesDir = p;
    break;
  }
}

if (!articlesDir) {
  console.log('Listing parent directories for debugging...');
  try {
    console.log('Contents of ../..:', fs.readdirSync(path.join(process.cwd(), '../..')));
  } catch (e) {
    console.log('Cannot read ../..:', e.message);
  }
  try {
    console.log('Contents of /vercel:', fs.readdirSync('/vercel'));
  } catch (e) {
    console.log('Cannot read /vercel:', e.message);
  }
  console.error('ERROR: Could not find articles directory');
  process.exit(1);
}

console.log('Found articles at:', articlesDir);

// Create content/articles directory
const targetDir = path.join(process.cwd(), 'content/articles');
fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

// Copy essay files
const files = fs.readdirSync(articlesDir).filter(f => f.startsWith('essay-') && f.endsWith('.md'));
console.log('Copying', files.length, 'files...');

for (const file of files) {
  fs.copyFileSync(path.join(articlesDir, file), path.join(targetDir, file));
}

console.log('Done!');
