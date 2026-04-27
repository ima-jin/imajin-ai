import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/chat/src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: require("@imajin/tokens/dist/tailwind.js"),
  },
  plugins: [require("@tailwindcss/typography")],
};

export default config;
