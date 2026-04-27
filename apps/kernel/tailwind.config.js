/** @type {import("tailwindcss").Config} */
const tokenTheme = require('@imajin/tokens/dist/tailwind.js');

module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/chat/src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      ...tokenTheme,
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
