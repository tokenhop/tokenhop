import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/mediaProviderKinds";
import { PROVIDER_DISPLAY } from "@/shared/constants/providerDisplay.generated";
import { COMBINED_WEB_ITEM } from "@/shared/constants/navigation";

const MEDIA_LIST_TITLE = "Media providers";
const MEDIA_LIST_DESCRIPTION = "Embeddings, images, voice and web. Same endpoint, same keys.";

/**
 * Pure header info for every /dashboard/media-providers route (YAN-402).
 * List routes (root, /[kind], /web) share one stable H1 and the board
 * subtitle; detail and combo pages render their own in-page H1 (YAN-314), so
 * the shell only shows breadcrumbs there. Returns null for non-media routes
 * so the caller falls through to its other page mappings.
 *
 * @param {string} pathname
 * @returns {{ title: string, description: string, icon?: string, breadcrumbs: Array<object> } | null}
 */
export function getMediaRouteInfo(pathname) {
  if (typeof pathname !== "string" || !pathname.includes("/media-providers")) return null;

  // Media provider detail: /dashboard/media-providers/[kind]/[id]
  const mediaDetailMatch = pathname.match(/\/media-providers\/([^/]+)\/([^/]+)$/);
  if (mediaDetailMatch) {
    const kindId = mediaDetailMatch[1];
    const providerId = mediaDetailMatch[2];
    if (kindId === "combo") {
      return {
        title: "",
        description: "",
        breadcrumbs: [
          { label: "Media providers", href: "/dashboard/media-providers" },
          { label: "Combo", href: "/dashboard/media-providers" },
          { label: providerId },
        ],
      };
    }
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    const provider = PROVIDER_DISPLAY[providerId];
    return {
      title: "",
      description: "",
      breadcrumbs: [
        { label: "Media providers", href: `/dashboard/media-providers/${kindId}` },
        { label: kindConfig?.label || kindId, href: `/dashboard/media-providers/${kindId}` },
        { label: provider?.name || providerId, providerId },
      ],
    };
  }

  // Media provider kind: /dashboard/media-providers/[kind] (the root
  // redirects to the first kind, so a bare /media-providers also lands here).
  const mediaKindMatch = pathname.match(/\/media-providers(\/[^/]+)?$/);
  if (mediaKindMatch) {
    const kindId = mediaKindMatch[1]?.replace(/^\//, "");
    // The combined web page has no MEDIA_PROVIDER_KINDS entry; legacy showed the raw "web" id.
    const kindConfig =
      kindId === COMBINED_WEB_ITEM.id
        ? COMBINED_WEB_ITEM
        : MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    // Every media list route (kind tab or /web) shares the stable H1 and
    // board subtitle; the kind only varies the icon.
    return {
      title: MEDIA_LIST_TITLE,
      description: MEDIA_LIST_DESCRIPTION,
      icon: kindConfig?.icon || "perm_media",
      breadcrumbs: [],
    };
  }

  return null;
}
