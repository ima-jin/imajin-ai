/** @type {import('tailwindcss').Config} */
const tokenTheme = require('@imajin/tokens/dist/tailwind.js');

module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: "class",
  theme: {
    extend: {
      ...tokenTheme,
    },
  },
  plugins: [],
};
