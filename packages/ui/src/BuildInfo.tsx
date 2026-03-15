// Set NEXT_PUBLIC_VERSION and NEXT_PUBLIC_BUILD_HASH at build time
// e.g. NEXT_PUBLIC_VERSION=$(git describe --tags --always) NEXT_PUBLIC_BUILD_HASH=$(git rev-parse HEAD)

const WWW_URL = process.env.NEXT_PUBLIC_WWW_URL || "https://imajin.ai";

export function BuildInfo() {
  const version = process.env.NEXT_PUBLIC_VERSION || "dev";
  const hash = process.env.NEXT_PUBLIC_BUILD_HASH || "local";
  const isDev = version === "dev" || version.includes("dev");
  return (
    <a
      href={`${WWW_URL}/build`}
      className={`text-xs hover:underline ${isDev ? "text-yellow-600" : "text-gray-500"}`}
    >
      imajin {version} · build {hash.slice(0, 7)}
    </a>
  );
}
