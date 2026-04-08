import { IdentityProvider } from "./context/IdentityContext";

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <IdentityProvider>{children}</IdentityProvider>;
}
