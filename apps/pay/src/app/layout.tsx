export const metadata = { title: "Imajin Pay", description: "Unified payment infrastructure for the sovereign stack." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className="dark"><body className="min-h-screen bg-[#0a0a0a] text-white">{children}</body></html>;
}
