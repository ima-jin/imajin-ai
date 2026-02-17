/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        imajin: {
          orange: '#FF6B35',
          dark: '#0A0A0A',
          gray: '#1A1A1A',
        },
      },
    },
  },
  plugins: [],
};
