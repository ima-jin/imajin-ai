// Set NEXT_PUBLIC_VERSION, NEXT_PUBLIC_BUILD_HASH, and NEXT_PUBLIC_COMMIT_COUNT at build time.
// scripts/build.sh sets these from the root package.json `version` field and
// `git rev-parse`/`git rev-list --count` — NOT from a git tag, so bumping the
// root package.json version is what actually changes what renders here.

import { buildPublicUrl, APP_DISPLAY_NAME } from "@imajin/config";

export function BuildInfo() {
  const version = process.env.NEXT_PUBLIC_VERSION || "dev";
  const hash = process.env.NEXT_PUBLIC_BUILD_HASH || "local";
  const commitCount = process.env.NEXT_PUBLIC_COMMIT_COUNT || "";
  const isDev = version === "dev" || version.includes("dev");
  const display = commitCount ? `${version}+${commitCount}` : version;
  return (
    <a
      href={`${buildPublicUrl("kernel")}/build`}
      className={`text-xs hover:underline ${isDev ? "text-yellow-600" : "text-gray-500"}`}
    >
      {APP_DISPLAY_NAME} {display} · build {hash.slice(0, 7)}
    </a>
  );
}
