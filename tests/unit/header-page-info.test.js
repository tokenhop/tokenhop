import { describe, expect, it } from "vitest";
import { getMediaRouteInfo } from "@/app/(dashboard)/dashboard/media-providers/components/mediaPageInfo.js";

describe("getMediaRouteInfo (YAN-402)", () => {
  const LIST_INFO = {
    title: "Media providers",
    description: "Embeddings, images, voice and web. Same endpoint, same keys.",
    breadcrumbs: [],
  };

  it("every media list route shares the stable H1 and board subtitle", () => {
    expect(getMediaRouteInfo("/dashboard/media-providers/embedding")).toEqual({
      ...LIST_INFO,
      icon: "data_array",
    });
    expect(getMediaRouteInfo("/dashboard/media-providers/web")).toEqual({
      ...LIST_INFO,
      icon: "travel_explore",
    });
    // The root redirects to the first kind; it shows the same header.
    expect(getMediaRouteInfo("/dashboard/media-providers")).toMatchObject(LIST_INFO);
    // Unknown kind segments fall back to the media icon, never a raw id title.
    expect(getMediaRouteInfo("/dashboard/media-providers/mystery")).toEqual({
      ...LIST_INFO,
      icon: "perm_media",
    });
  });

  it("does not match sibling routes that merely contain the media prefix", () => {
    expect(getMediaRouteInfo("/dashboard/media-providersX")).toBeNull();
    expect(getMediaRouteInfo("/dashboard/providers")).toBeNull();
  });

  it("detail routes keep kind-crumb labels sentence case and no shell H1", () => {
    const info = getMediaRouteInfo("/dashboard/media-providers/image/anthropic");
    expect(info.title).toBe("");
    expect(info.description).toBe("");
    expect(info.breadcrumbs.map((crumb) => crumb.label)).toEqual([
      "Media providers",
      "Text to image",
      "Anthropic",
    ]);
  });

  it("combo routes keep the combo breadcrumb", () => {
    const info = getMediaRouteInfo("/dashboard/media-providers/combo/my-combo");
    expect(info.breadcrumbs.map((crumb) => crumb.label)).toEqual([
      "Media providers",
      "Combo",
      "my-combo",
    ]);
  });
});
