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
      <body className="min-h-screen bg-[#1a1a1a] text-white">
        <main className="container mx-auto px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
