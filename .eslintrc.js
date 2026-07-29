/** @type {import('eslint').Linter.Config} */
module.exports = {
  plugins: ['sonarjs'],
  rules: {
    // Sonar S3776 — warn now, flip to error when epic #1466 closes
    'sonarjs/cognitive-complexity': ['warn', 15],
    // S2004 (sonarjs/no-nested-functions) requires eslint-plugin-sonarjs v2+
    // which needs ESLint v9 flat config — deferred until ESLint upgrade
  },
};
