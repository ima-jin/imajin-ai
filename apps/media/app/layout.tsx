import type { Metadata } from "next";
import "./globals.css";
import { themeInitScript } from "@imajin/ui";

export const metadata: Metadata = {
  title: "Imajin Media",
  description: "Sovereign media storage for the imajin network.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="h-screen flex flex-col overflow-hidden bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-white">
        {children}
      </body>
    </html>
  );
}
