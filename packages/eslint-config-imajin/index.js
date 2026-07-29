/** @type {import('eslint').Linter.Config} */
module.exports = {
  extends: ['next/core-web-vitals'],
  plugins: ['sonarjs'],
  rules: {
    'react/no-unescaped-entities': 'off',
    '@next/next/no-img-element': 'off',
    // Sonar S3776 — warn now, flip to error when epic #1466 closes
    'sonarjs/cognitive-complexity': ['warn', 15],
    // Sonar S2004 — warn now, flip to error when epic #1466 closes
    'sonarjs/no-nested-functions': ['warn', 4],
  },
  overrides: [
    {
      files: ['app/**/page.tsx', 'app/**/layout.tsx', 'app/api/**/*.ts'],
      rules: {
        'no-console': 'error',
      },
    },
  ],
};
