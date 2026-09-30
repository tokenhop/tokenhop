"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { getProvidersByKind, MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { MediaKindSection } from "../components/MediaKindSection";
import { MediaPlayground } from "../components/MediaPlayground";

/**
 * Signal web fetch and search tab (YAN-305): two kind sections plus one
 * shared playground. Web search + web fetch share this tab per the board.
 */
export default function WebProvidersPage() {
  const [connections, setConnections] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [playgroundKind, setPlaygroundKind] = useState("webSearch");

  useEffect(() => {
    fetch("/api/providers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setConnections(d.connections || []))
      .catch(() => {});
  }, []);

  const openPlayground = (kind) => {
    setPlaygroundKind(kind);
    setDrawerOpen(true);
  };

  return (
    <div className="flex min-w-0 flex-col gap-8 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        <section aria-labelledby="web-search-section">
          <SectionHeader kindId="webSearch" icon="search" headingId="web-search-section" />
          <MediaKindSection
            kind="webSearch"
            supportsCombo
            comboBaseName="search-combo"
            onOpenPlayground={() => openPlayground("webSearch")}
          />
        </section>

        <div className="border-t border-line" />

        <section aria-labelledby="web-fetch-section">
          <SectionHeader kindId="webFetch" icon="travel_explore" headingId="web-fetch-section" />
          <MediaKindSection
            kind="webFetch"
            supportsCombo
            comboBaseName="fetch-combo"
            onOpenPlayground={() => openPlayground("webFetch")}
          />
        </section>
      </div>

      {/* Playground aside on desktop, Drawer on narrow widths */}
      <div className="hidden w-[420px] shrink-0 lg:block xl:w-[460px]">
        <MediaPlayground kind={playgroundKind} connections={connections} />
      </div>
      <WebPlaygroundDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        kind={playgroundKind}
        connections={connections}
      />
    </div>
  );
}

function SectionHeader({ icon, kindId, headingId }) {
  const title = MEDIA_PROVIDER_KINDS.find((kind) => kind.id === kindId)?.label || kindId;
  const count = getProvidersByKind(kindId).length;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="flex size-10 items-center justify-center rounded-[10px] bg-coral-bg text-coral-ink">
        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
          {icon}
        </span>
      </span>
      <h2 id={headingId} className="font-display text-xl font-bold text-text">
        {title}
      </h2>
      <span className="font-mono text-xs text-muted">{count} providers</span>
    </div>
  );
}

SectionHeader.propTypes = {
  icon: PropTypes.string.isRequired,
  kindId: PropTypes.string.isRequired,
  headingId: PropTypes.string.isRequired,
};

WebProvidersPage.propTypes = {};

function WebPlaygroundDrawer({ open, onClose, kind, connections }) {
  const [DrawerComponent, setDrawerComponent] = useState(null);
  useEffect(() => {
    if (!open || DrawerComponent) return;
    import("@/shared/components/Drawer").then((m) => setDrawerComponent(() => m.default));
  }, [open, DrawerComponent]);
  if (!DrawerComponent) return null;
  return (
    <DrawerComponent
      isOpen={open}
      onClose={onClose}
      title={`${kind === "webFetch" ? "Web fetch" : "Web search"} playground`}
      width="lg"
    >
      <MediaPlayground kind={kind} connections={connections} />
    </DrawerComponent>
  );
}

WebPlaygroundDrawer.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func,
  kind: PropTypes.string.isRequired,
  connections: PropTypes.array,
};
