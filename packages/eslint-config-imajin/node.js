// Flat config for Node.js/TypeScript packages.
// The root eslint.config.mjs is the primary entry point;
// this file is kept for standalone per-package use if needed.
'use strict';

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const sonarjs = require('eslint-plugin-sonarjs');
const globals = require('globals');

/** @type {import('eslint').Linter.Config[]} */
module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    plugins: { sonarjs },
    rules: {
      // Sonar S3776 — warn now, flip to error when epic #1466 closes
      'sonarjs/cognitive-complexity': ['warn', 15],
      // Sonar S2004 — warn now, flip to error when epic #1466 closes
      'sonarjs/no-nested-functions': ['warn', { threshold: 4 }],
    },
  },
);
