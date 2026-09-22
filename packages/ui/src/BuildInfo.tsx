// Set NEXT_PUBLIC_VERSION, NEXT_PUBLIC_BUILD_HASH, and NEXT_PUBLIC_COMMIT_COUNT at build time.
// scripts/build.sh derives these from `git describe --tags` (the nearest
// reachable tag, stripped of its leading "v") and `git rev-parse`/
// `git rev-list --count` (#2285). Tag is truth: falls back to the root
// package.json `version` field only on an untagged checkout, then "dev".
// Cutting a release (.github/workflows/release.yml) is what actually changes
// what renders here — bumping package.json alone does not, once a newer tag
// exists.

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
