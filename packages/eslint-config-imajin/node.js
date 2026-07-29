/** @type {import('eslint').Linter.Config} */
module.exports = {
  env: {
    node: true,
    es2020: true,
  },
  extends: ['eslint:recommended'],
  plugins: ['sonarjs'],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    // Sonar S3776 — warn now, flip to error when epic #1466 closes
    'sonarjs/cognitive-complexity': ['warn', 15],
    // S2004 (sonarjs/no-nested-functions) requires eslint-plugin-sonarjs v2+
    // which needs ESLint v9 flat config — deferred until ESLint upgrade
  },
  overrides: [
    {
      files: ['*.ts', '*.tsx'],
      parser: '@typescript-eslint/parser',
      extends: ['plugin:@typescript-eslint/recommended'],
      rules: {
        '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        '@typescript-eslint/no-explicit-any': 'warn',
      },
    },
  ],
};
