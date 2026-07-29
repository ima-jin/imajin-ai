// Flat config for Next.js apps.
// The root eslint.config.mjs is the primary entry point;
// this file is kept for standalone per-app use if needed.
'use strict';

const { FlatCompat } = require('@eslint/eslintrc');
const js = require('@eslint/js');
const sonarjs = require('eslint-plugin-sonarjs');
const path = require('node:path');

const compat = new FlatCompat({
  baseDirectory: path.dirname(require.resolve('./package.json')),
  recommendedConfig: js.configs.recommended,
});

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  ...compat.extends('next/core-web-vitals').map(config => ({
    ...config,
    files: ['**/*.{ts,tsx,js,jsx}'],
  })),
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: { sonarjs },
    rules: {
      'react/no-unescaped-entities': 'off',
      '@next/next/no-img-element': 'off',
      // Sonar S3776 — warn now, flip to error when epic #1466 closes
      'sonarjs/cognitive-complexity': ['warn', 15],
      // Sonar S2004 — warn now, flip to error when epic #1466 closes
      'sonarjs/no-nested-functions': ['warn', { threshold: 4 }],
    },
  },
  {
    files: ['**/app/**/page.tsx', '**/app/**/layout.tsx', '**/app/api/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
];
