import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en" className="dark">
      <body className="h-screen overflow-hidden bg-[#1a1a1a] text-white">
        {children}
      </body>
    </html>
  );
}
