module.exports = {
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
