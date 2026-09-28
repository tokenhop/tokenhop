"use client";

import { useParams, notFound, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import {
  Button,
  Callout,
  ConfirmDialog,
  ProviderTile,
  Skeleton,
  StatusPill,
  AddCustomEmbeddingModal,
  NoAuthProxyCard,
  ProviderInfoCard,
} from "@/shared/components";
import {
  MEDIA_PROVIDER_KINDS,
  AI_PROVIDERS,
  isCustomEmbeddingProvider,
} from "@/shared/constants/providers";
import { getProviderBrand } from "@/shared/constants/providerBrands";
import ConnectionsCard from "@/app/(dashboard)/dashboard/providers/components/ConnectionsCard";
import ModelsCard from "@/app/(dashboard)/dashboard/providers/components/ModelsCard";
import { KIND_EXAMPLE_CONFIG } from "./components/exampleShared";
import { EmbeddingExampleCard } from "./components/EmbeddingExampleCard";
import { TtsExampleCard } from "./components/TtsExampleCard";
import { GenericExampleCard } from "./components/GenericExampleCard";
import { SttExampleCard } from "./components/SttExampleCard";

// MediaProviderDetailPage
export default function MediaProviderDetailPage() {
  const { kind, id } = useParams();
  const router = useRouter();
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  const isCustom = isCustomEmbeddingProvider(id) && kind === "embedding";

  const [customNode, setCustomNode] = useState(null);
  const [customLoading, setCustomLoading] = useState(isCustom);
  const [showEditModal, setShowEditModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Throws on failure so ConfirmDialog shows the error inline and stays open.
  const handleDeleteCustom = async () => {
    const res = await fetch(`/api/provider-nodes/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error?.message || data?.error || `Delete failed (HTTP ${res.status})`);
    }
    router.push(`/dashboard/media-providers/${kind}`);
  };

  // Fetch custom node info from API for custom embedding nodes
  useEffect(() => {
    if (!isCustom) return;
    let cancelled = false;
    fetch("/api/provider-nodes", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setCustomNode((d.nodes || []).find((n) => n.id === id) || null);
        setCustomLoading(false);
      })
      .catch(() => {
        if (!cancelled) setCustomLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, isCustom]);

  if (!kindConfig) return notFound();

  const builtInProvider = AI_PROVIDERS[id];

  // For custom embedding nodes, build a synthetic provider object
  const provider = isCustom
    ? customNode
      ? {
          id,
          name: customNode.name || "Custom Embedding",
          color: getProviderBrand("custom-embedding").color,
          textIcon: "CE",
        }
      : null
    : builtInProvider;

  if (!isCustom && !builtInProvider) return notFound();
  if (isCustom && !customLoading && !customNode) return notFound();
  if (isCustom && customLoading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <span className="sr-only" role="status">
          Loading provider
        </span>
        <Skeleton className="h-5 w-32" />
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-xl" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-64" />
          </div>
        </div>
        <Skeleton className="h-48 w-full rounded-2xl" />
      </div>
    );
  }

  const kinds = isCustom ? ["embedding"] : (provider.serviceKinds ?? ["llm"]);
  if (!isCustom && !kinds.includes(kind)) return notFound();

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="Back to media providers">
        <Link
          href={`/dashboard/media-providers/${kind}`}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-sm text-muted transition-colors hover:text-text focus-visible:shadow-focus"
        >
          <span className="material-symbols-outlined text-lg rtl:-scale-x-100" aria-hidden="true">
            arrow_back
          </span>
          {kindConfig.label}
        </Link>
      </nav>

      <header className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-5">
        <ProviderTile providerId={isCustom ? "custom-embedding" : provider.id} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">
            {kindConfig.label} provider
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 sm:gap-3">
            <h1 className="font-display text-[42px] leading-[1.05] font-bold text-text">
              {provider.name}
            </h1>
            {!isCustom && provider.notice?.apiKeyUrl && (
              <a
                href={provider.notice.apiKeyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-10 items-center gap-1 text-sm text-coral-ink transition-colors hover:text-coral"
              >
                <span className="material-symbols-outlined text-sm" aria-hidden="true">
                  open_in_new
                </span>
                Get API Key
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {isCustom && (
              <StatusPill variant="neutral" size="sm">
                Custom · <span className="font-mono">{customNode?.prefix ?? id}</span>
              </StatusPill>
            )}
            {kinds.map((k) => (
              <StatusPill key={k} variant={k === kind ? "brand" : "neutral"} size="sm">
                {k.toUpperCase()}
              </StatusPill>
            ))}
          </div>
        </div>
        {isCustom && (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Button
              size="md"
              variant="secondary"
              icon="edit"
              onClick={() => setShowEditModal(true)}
            >
              Edit
            </Button>
            <Button size="md" variant="danger" icon="delete" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        )}
      </header>

      {/* Kind-specific notice (e.g. codex/image requires Plus) */}
      {!isCustom && provider.kindNotice?.[kind] && (
        <Callout variant="warn">{provider.kindNotice[kind]}</Callout>
      )}

      {/* Provider notice text (only when there's actual text content) */}
      {!isCustom && provider.notice?.text && !provider.deprecated && (
        <Callout variant="info">
          <p className="min-w-0 flex-1 text-xs leading-relaxed">{provider.notice.text}</p>
          {provider.notice.apiKeyUrl && (
            <Button
              size="sm"
              variant="secondary"
              iconRight="open_in_new"
              href={provider.notice.apiKeyUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Get API Key
              <span className="sr-only">(opens in a new tab)</span>
            </Button>
          )}
        </Callout>
      )}

      {/* Connections */}
      {!isCustom && provider.noAuth ? (
        <NoAuthProxyCard providerId={id} />
      ) : (
        <ConnectionsCard providerId={id} isOAuth={false} />
      )}

      {/* Models - hidden for tts/webSearch/webFetch (provider IS the model); custom uses prefix as alias */}
      {kind !== "tts" && kind !== "webSearch" && kind !== "webFetch" && (
        <ModelsCard
          providerId={id}
          kindFilter={kind}
          providerAliasOverride={isCustom ? customNode?.prefix : undefined}
        />
      )}

      {/* Provider Info — config-driven, supports searchConfig, fetchConfig, ttsConfig, embeddingConfig, searchViaChat */}
      {!isCustom &&
        (provider.searchConfig ||
          provider.fetchConfig ||
          provider.ttsConfig ||
          provider.sttConfig ||
          provider.embeddingConfig ||
          provider.searchViaChat) && (
          <ProviderInfoCard
            config={
              kind === "webFetch"
                ? provider.fetchConfig
                : kind === "tts"
                  ? provider.ttsConfig
                  : kind === "stt"
                    ? provider.sttConfig
                    : kind === "embedding"
                      ? provider.embeddingConfig
                      : provider.searchConfig || {
                          mode: "chat-completions",
                          defaultModel: provider.searchViaChat?.defaultModel,
                          pricingUrl: provider.searchViaChat?.pricingUrl,
                          freeTier: provider.searchViaChat?.freeTier,
                        }
            }
            provider={provider}
            title={`${kindConfig.label} Config`}
          />
        )}

      {/* Example — per kind */}
      {kind === "embedding" && (
        <EmbeddingExampleCard providerId={id} customAlias={customNode?.prefix} />
      )}
      {kind === "tts" && <TtsExampleCard providerId={id} />}
      {kind === "stt" && !isCustom && <SttExampleCard providerId={id} />}
      {!isCustom && KIND_EXAMPLE_CONFIG[kind] && <GenericExampleCard providerId={id} kind={kind} />}

      {isCustom && (
        <>
          <AddCustomEmbeddingModal
            isOpen={showEditModal}
            node={customNode}
            onClose={() => setShowEditModal(false)}
            onSaved={(updated) => {
              setCustomNode(updated);
              setShowEditModal(false);
            }}
          />
          <ConfirmDialog
            isOpen={confirmDelete}
            onClose={() => setConfirmDelete(false)}
            onConfirm={async () => {
              await handleDeleteCustom();
              setConfirmDelete(false);
            }}
            title="Delete custom provider"
            message="Delete this Custom Embedding node?"
            confirmText="Delete"
          />
        </>
      )}
    </div>
  );
}
