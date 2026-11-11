// From the repository root: node apps/kernel/public/render-og-image.mjs
// Edit og-image.svg from docs/POSITIONING.md before regenerating the PNG.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import sharp from 'sharp';

const source = await readFile(new URL('./og-image.svg', import.meta.url));
await sharp(source).png().toFile(fileURLToPath(new URL('./og-image.png', import.meta.url)));
