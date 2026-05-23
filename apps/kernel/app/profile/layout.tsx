import { IdentityProvider } from "./context/IdentityContext";

export default function ProfileLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <IdentityProvider>{children}</IdentityProvider>;
}
