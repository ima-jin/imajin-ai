module.exports = {
  overrides: [
    {
      files: [
        'apps/**/app/**/page.tsx',
        'apps/**/app/**/layout.tsx',
        'apps/**/app/api/**/*.ts',
        'apps/**/src/**/*.ts',
      ],
      rules: {
        'no-console': 'error',
      },
    },
  ],
};
