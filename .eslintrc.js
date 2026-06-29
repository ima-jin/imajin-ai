module.exports = {
  plugins: ['sonarjs'],
  extends: ['plugin:sonarjs/recommended-legacy'],
  rules: {
    // Rules that mirror recurring Sonar issues (S-numbers) in this codebase.
    // Run locally via `pnpm lint` to catch these before push.
    'sonarjs/sonar-prefer-optional-chain': 'error', // S6582 — x && x.y -> x?.y
    'sonarjs/no-nested-template-literals': 'error',  // S4624 — backtick inside backtick
    'no-nested-ternary': 'error',                    // S3358 — nested ternaries
    // Disable preset rules that flag pre-existing code we are not refactoring in this PR.
    // These remain enforced by SonarCloud on new code only.
    'sonarjs/cognitive-complexity': 'off',           // pre-existing complexity in packages/fair
    'sonarjs/class-name': 'off',                     // version-suffixed interface names (FairManifestV1_1)
  },
  overrides: [
    {
      files: [
        'apps/**/app/**/page.tsx',
        'apps/**/app/**/layout.tsx',
        'apps/**/app/api/**/*.ts',
      ],
      rules: {
        'no-console': 'error',
      },
    },
  ],
};
