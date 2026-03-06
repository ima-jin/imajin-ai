import { redirect } from "next/navigation";

export default function LoginRedirect({ searchParams }: { searchParams: { next?: string } }) {
  const authDomain = process.env.NEXT_PUBLIC_AUTH_URL ||
    `${process.env.NEXT_PUBLIC_SERVICE_PREFIX || "https://"}auth.${process.env.NEXT_PUBLIC_DOMAIN || "imajin.ai"}`;
  const next = searchParams.next ? `?next=${encodeURIComponent(searchParams.next)}` : "";
  redirect(`${authDomain}/login${next}`);
}
