import { redirect } from "next/navigation";
import { buildPublicUrl } from "@imajin/config";

export default function LoginRedirect({ searchParams }: { searchParams: { next?: string } }) {
  const authUrl = buildPublicUrl('auth');
  const next = searchParams.next ? `?next=${encodeURIComponent(searchParams.next)}` : "";
  redirect(`${authUrl}/login${next}`);
}
