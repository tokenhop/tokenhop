"use client";

import { useEffect, useState } from "react";
import { useParams, notFound, useRouter } from "next/navigation";
import PropTypes from "prop-types";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { MediaKindSection } from "../components/MediaKindSection";
import { MediaPlayground } from "../components/MediaPlayground";

// Combos page contract: every media kind supports a combo row + Create combo,
// and web kinds route their combo editor back to /web.
const COMBO_KINDS = new Set(["embedding", "image", "video", "tts", "stt", "webSearch", "webFetch"]);
const COMBO_BASE_NAMES = {
  embedding: "embedding-combo",
  image: "image-combo",
  video: "video-combo",
  tts: "tts-combo",
  stt: "stt-combo",
  webSearch: "search-combo",
  webFetch: "fetch-combo",
};

/**
 * Signal media kind page (YAN-305): combos row, provider grid and the Try-it
 * playground side by side (Drawer on narrow widths). Deep routes stay the
 * source of truth for kind tabs (`/[kind]`, `/[kind]/[id]`).
 */
export default function MediaProviderKindPage() {
  const { kind } = useParams();
  const router = useRouter();
  const [connections, setConnections] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // webSearch/webFetch listing pages are merged into /web
  useEffect(() => {
    if (kind === "webSearch" || kind === "webFetch") {
      router.replace("/dashboard/media-providers/web");
    }
  }, [kind, router]);

  useEffect(() => {
    fetch("/api/providers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setConnections(d.connections || []))
      .catch(() => {});
  }, []);

  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  if (!kindConfig) return notFound();

  const isEmbedding = kind === "embedding";

  return (
    <div className="flex min-w-0 flex-col gap-5 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1">
        <MediaKindSection
          kind={kind}
          supportsCombo={COMBO_KINDS.has(kind)}
          comboBaseName={COMBO_BASE_NAMES[kind]}
          showCustomEmbedding={isEmbedding}
          onOpenPlayground={() => setDrawerOpen(true)}
        />
      </div>
      {/* Playground aside on desktop, Drawer on narrow widths */}
      <div className="hidden w-[420px] shrink-0 lg:block xl:w-[460px]">
        <MediaPlayground kind={kind} connections={connections} />
      </div>
      <MediaPlaygroundDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={`${kindConfig?.label || kind} playground`}
        kind={kind}
        connections={connections}
      />
    </div>
  );
}

MediaProviderKindPage.propTypes = {};

function MediaPlaygroundDrawer({ open, onClose, title, kind, connections }) {
  const [DrawerComponent, setDrawerComponent] = useState(null);
  useEffect(() => {
    if (!open || DrawerComponent) return;
    import("@/shared/components/Drawer").then((m) => setDrawerComponent(() => m.default));
  }, [open, DrawerComponent]);
  if (!DrawerComponent) return null;
  return (
    <DrawerComponent isOpen={open} onClose={onClose} title={title} width="lg">
      <MediaPlayground kind={kind} connections={connections} />
    </DrawerComponent>
  );
}

MediaPlaygroundDrawer.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func,
  title: PropTypes.node,
  kind: PropTypes.string.isRequired,
  connections: PropTypes.array,
};
