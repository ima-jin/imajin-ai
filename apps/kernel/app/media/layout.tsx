import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Imajin Media",
  description: "Sovereign media storage for the imajin network.",
  openGraph: {
    title: "Imajin Media",
    description: "Sovereign media storage for the imajin network.",
    siteName: "Imajin",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Imajin Media",
    description: "Sovereign media storage for the imajin network.",
  },
};

export default function MediaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {children}
    </div>
  );
}
