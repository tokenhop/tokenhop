"use client";

import { useEffect, useState, useCallback } from "react";
import PropTypes from "prop-types";
import { useRouter } from "next/navigation";
import { Button, AddCustomEmbeddingModal } from "@/shared/components";
import { getProvidersByKind, MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { MediaProviderGrid, ComboList } from "./MediaCards";

/**
 * Shared kind page content: combos row, Create combo / Add custom embedding,
 * provider grid with status pills + hover toggle, and the Try-it playground
 * launcher. Used by [kind]/page.js and both web sections (YAN-305).
 *
 * @param {object} props
 * @param {string} props.kind Kind id (embedding, image, video, tts, stt, webSearch, webFetch).
 * @param {boolean} [props.supportsCombo=false]
 * @param {string} [props.comboBaseName]
 * @param {boolean} [props.showCustomEmbedding=false]
 * @param {Array<object>} [props.extraProviders=[]] Custom nodes mapped to card shape.
 * @param {Function} [props.onOpenPlayground] Opens playground drawer on narrow widths.
 */
export function MediaKindSection({
  kind,
  supportsCombo = false,
  comboBaseName,
  showCustomEmbedding = false,
  extraProviders = [],
  onOpenPlayground,
}) {
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  const router = useRouter();
  const [connections, setConnections] = useState([]);
  const [customNodes, setCustomNodes] = useState([]);
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [showAddCustomEmbedding, setShowAddCustomEmbedding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const connsRes = await fetch("/api/providers", { cache: "no-store" });
      if (!connsRes.ok) throw new Error(`Providers ${connsRes.status}`);
      const connsData = await connsRes.json();
      setConnections(connsData.connections || []);

      if (showCustomEmbedding) {
        const nodesRes = await fetch("/api/provider-nodes", { cache: "no-store" });
        if (nodesRes.ok) {
          const nodesData = await nodesRes.json();
          setCustomNodes((nodesData.nodes || []).filter((n) => n.type === "custom-embedding"));
        }
      }

      if (supportsCombo) {
        const combosRes = await fetch("/api/combos", { cache: "no-store" });
        if (combosRes.ok) {
          const combosData = await combosRes.json();
          setCombos(combosData.combos || []);
        }
      }
    } catch (e) {
      setError(e.message || "Failed to load providers");
    } finally {
      setLoading(false);
    }
  }, [showCustomEmbedding, supportsCombo]);

  useEffect(() => {
    load();
  }, [load]);

  const providers = getProvidersByKind(kind);
  const kindCombos = combos.filter((c) => c.kind === kind);
  const mappedCustom = (showCustomEmbedding ? customNodes : []).map((n) => ({
    id: n.id,
    name: n.name || "Custom Embedding",
    isCustom: true,
  }));
  const allProviders = [...providers, ...mappedCustom, ...extraProviders];

  const handleToggleProvider = async (providerId, newActive) => {
    const providerConns = connections.filter((c) => c.provider === providerId);
    setConnections((prev) =>
      prev.map((c) => (c.provider === providerId ? { ...c, isActive: newActive } : c)),
    );
    await Promise.allSettled(
      providerConns.map((c) =>
        fetch(`/api/providers/${c.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: newActive }),
        }),
      ),
    );
  };

  const handleCreateCombo = async () => {
    setErrorMessage("");
    const base = comboBaseName || `${kind}-combo`;
    let name = base;
    let i = 1;
    const existing = new Set(combos.map((c) => c.name));
    while (existing.has(name)) {
      name = `${base}-${i++}`;
    }
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, models: [], kind }),
      });
      if (res.ok) {
        const created = await res.json();
        router.push(`/dashboard/media-providers/combo/${created.id}`);
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorMessage(err.error || "Failed to create combo");
      }
    } catch {
      setErrorMessage("Failed to create combo");
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/* Actions row: Create combo + custom embedding + Try it (narrow) */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onOpenPlayground && (
          <Button
            size="sm"
            variant="secondary"
            icon="labs"
            onClick={onOpenPlayground}
            className="lg:hidden"
          >
            Try it
          </Button>
        )}
        {supportsCombo && (
          <Button size="sm" variant="secondary" icon="add" onClick={handleCreateCombo}>
            Create combo
          </Button>
        )}
        {showCustomEmbedding && (
          <Button
            size="sm"
            variant="secondary"
            icon="add"
            onClick={() => setShowAddCustomEmbedding(true)}
          >
            Add custom embedding
          </Button>
        )}
      </div>

      {errorMessage && (
        <p className="text-end text-xs text-err" role="alert">
          {errorMessage}
        </p>
      )}

      {supportsCombo && kindCombos.length > 0 && <ComboList combos={kindCombos} />}

      <MediaProviderGrid
        providers={allProviders}
        kind={kind}
        connections={connections}
        loading={loading}
        error={error}
        onRetry={load}
        onToggle={handleToggleProvider}
        emptyTitle={`No providers support ${kindConfig?.label || kind} yet`}
        emptyBody="Connect a provider that offers this capability to get started."
        emptyAction={
          <Button size="sm" variant="secondary" icon="dns" href="/dashboard/providers">
            Browse providers
          </Button>
        }
      />

      {showCustomEmbedding && (
        <AddCustomEmbeddingModal
          isOpen={showAddCustomEmbedding}
          onClose={() => setShowAddCustomEmbedding(false)}
          onCreated={(node) => {
            setCustomNodes((prev) => [...prev, node]);
            setShowAddCustomEmbedding(false);
          }}
        />
      )}
    </div>
  );
}

MediaKindSection.propTypes = {
  kind: PropTypes.string.isRequired,
  supportsCombo: PropTypes.bool,
  comboBaseName: PropTypes.string,
  showCustomEmbedding: PropTypes.bool,
  extraProviders: PropTypes.array,
  onOpenPlayground: PropTypes.func,
};
