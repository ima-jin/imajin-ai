import { describe, expect, it } from "vitest";
import { buildAssetViewUrl } from "@/src/lib/media/view-url";

describe("buildAssetViewUrl", () => {
  it("joins the base URL and asset id into the canonical asset path", () => {
    expect(buildAssetViewUrl("https://jin.imajin.ai", "asset_abc123")).toBe(
      "https://jin.imajin.ai/media/api/assets/asset_abc123"
    );
  });

  it("strips a trailing slash from the base URL before joining", () => {
    expect(buildAssetViewUrl("https://jin.imajin.ai/", "asset_abc123")).toBe(
      "https://jin.imajin.ai/media/api/assets/asset_abc123"
    );
  });

  it("strips multiple trailing slashes from the base URL", () => {
    expect(buildAssetViewUrl("https://jin.imajin.ai///", "asset_abc123")).toBe(
      "https://jin.imajin.ai/media/api/assets/asset_abc123"
    );
  });
});
