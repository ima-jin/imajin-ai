/** @type {import('tailwindcss').Config} */
const tokenTheme = require('@imajin/tokens/dist/tailwind.js');

module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      ...tokenTheme,
    },
  },
  plugins: [],
};
