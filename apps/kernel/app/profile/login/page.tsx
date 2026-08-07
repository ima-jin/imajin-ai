import { redirect } from "next/navigation";
import { buildPublicUrl } from "@imajin/config";

export default async function LoginRedirect(props: { searchParams: Promise<{ next?: string }> }) {
  const searchParams = await props.searchParams;
  const authUrl = buildPublicUrl('auth');
  const next = searchParams.next ? `?next=${encodeURIComponent(searchParams.next)}` : "";
  redirect(`${authUrl}/login${next}`);
}
