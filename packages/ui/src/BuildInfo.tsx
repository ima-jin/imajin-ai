// Set NEXT_PUBLIC_VERSION, NEXT_PUBLIC_BUILD_HASH, and NEXT_PUBLIC_COMMIT_COUNT at build time.
// scripts/build.sh derives these from `git describe --tags --match 'v[0-9]*'`
// (#2285, #2287 — the nearest reachable vX.Y.Z tag, stripped of its leading
// "v"; see scripts/lib/build-version.sh) and `git rev-parse`/`git rev-list
// --count`. Tag is truth: falls back to the root package.json `version`
// field only on an untagged checkout, then "dev". A release PR merge
// (.github/workflows/release.yml) followed by .github/workflows/tag-release.yml
// tagging that merge commit is what actually changes what renders here —
// bumping package.json alone does not, once a newer tag exists.

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
