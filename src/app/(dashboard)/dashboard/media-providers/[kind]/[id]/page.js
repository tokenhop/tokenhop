"use client";

import { useParams, notFound, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import {
  Button,
  Callout,
  CardSkeleton,
  ConfirmDialog,
  PageTitle,
  ProviderTile,
  StatusPill,
  AddCustomEmbeddingModal,
  EditConnectionModal,
  NoAuthProxyCard,
  ProviderInfoCard,
} from "@/shared/components";
import {
  MEDIA_PROVIDER_KINDS,
  AI_PROVIDERS,
  isCustomEmbeddingProvider,
} from "@/shared/constants/providers";
import { getProviderBrand } from "@/shared/constants/providerBrands";
import ConnectionsSection from "@/app/(dashboard)/dashboard/providers/detail/ConnectionsSection";
import ModelsSection from "@/app/(dashboard)/dashboard/providers/detail/ModelsSection";
import { connectionLabels } from "@/app/(dashboard)/dashboard/providers/detail/providerDetailMeta";
import AddApiKeyModal from "@/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal";
import AddCustomModelModal from "@/app/(dashboard)/dashboard/providers/[id]/AddCustomModelModal";
import { KIND_EXAMPLE_CONFIG } from "./components/exampleShared";
import { EmbeddingExampleCard } from "./components/EmbeddingExampleCard";
import { TtsExampleCard } from "./components/TtsExampleCard";
import { GenericExampleCard } from "./components/GenericExampleCard";
import { SttExampleCard } from "./components/SttExampleCard";
import { useMediaProviderDetail } from "./useMediaProviderDetail";

// MediaProviderDetailPage — Signal sections on the media detail route.
export default function MediaProviderDetailPage() {
  const { kind, id } = useParams();
  const router = useRouter();
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  const isCustom = isCustomEmbeddingProvider(id) && kind === "embedding";
  const [showEditModal, setShowEditModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const {
    notifyError,
    customNode,
    setCustomNode,
    loading,
    fetchError,
    fetchDetail,
    loadNode,
    addConnectionError,
    setAddConnectionError,
    showAddApiKey,
    setShowAddApiKey,
    selectedConnection,
    setSelectedConnection,
    conn,
    strategy,
    models,
    storageAlias,
    staticModels,
    saveApiKey,
    updateConnection,
    saveCustomModel,
  } = useMediaProviderDetail({
    id,
    kind,
    isCustom,
    noAuth: !isCustom && !!AI_PROVIDERS[id]?.noAuth,
  });

  // Throws on failure so ConfirmDialog shows the error inline and stays open.
  const handleDeleteCustom = async () => {
    const res = await fetch(`/api/provider-nodes/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error?.message || data?.error || `Delete failed (HTTP ${res.status})`);
    }
    router.push(`/dashboard/media-providers/${kind}`);
  };

  if (!kindConfig) return notFound();

  const builtInProvider = AI_PROVIDERS[id];
  if (!isCustom && !builtInProvider) return notFound();
  const kinds = isCustom ? ["embedding"] : (builtInProvider.serviceKinds ?? ["llm"]);
  if (!isCustom && !kinds.includes(kind)) return notFound();

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

  if (loading) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true">
        <span className="sr-only" role="status">
          Loading provider
        </span>
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  // Custom node fetch failures surface as an error state, not a 404.
  if (isCustom && !provider) {
    if (!fetchError) return notFound();
    return (
      <div className="flex flex-col gap-4">
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
        <Callout variant="err" title="Could not load provider">
          <span className="flex flex-wrap items-center gap-2">
            {fetchError}
            <Button size="sm" variant="secondary" onClick={loadNode}>
              Retry
            </Button>
          </span>
        </Callout>
      </div>
    );
  }

  // Models hidden for tts/webSearch/webFetch (the provider IS the model).
  const showModels = kind !== "tts" && kind !== "webSearch" && kind !== "webFetch";
  const noAuth = !isCustom && provider.noAuth;

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
            <PageTitle>{provider.name}</PageTitle>
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

      {fetchError ? (
        <Callout variant="err" title="Could not load provider">
          <span className="flex flex-wrap items-center gap-2">
            {fetchError}
            <Button size="sm" variant="secondary" onClick={fetchDetail}>
              Retry
            </Button>
          </span>
        </Callout>
      ) : null}

      {/* Connections — media providers are API-key only */}
      {noAuth ? (
        <NoAuthProxyCard providerId={id} />
      ) : (
        <ConnectionsSection
          providerId={id}
          auth={{ isOAuth: false, hasDualAuthModes: false, labels: connectionLabels(id) }}
          strategy={strategy}
          conn={conn}
          autoPing={{ enabled: false, connections: {}, toggle: () => {} }}
          actions={{
            addButtons: (
              <Button
                size="sm"
                icon="key"
                variant="primary"
                onClick={() => {
                  setAddConnectionError("");
                  setShowAddApiKey(true);
                }}
              >
                Add connection
              </Button>
            ),
            edit: (entry) => {
              setSelectedConnection(entry);
            },
            notifyError,
          }}
        />
      )}

      {/* Models — custom embedding uses its node prefix as the alias */}
      {showModels && !fetchError && (
        <ModelsSection
          providerId={id}
          kind={kind}
          title={`Models — ${kind.toUpperCase()}`}
          storageAlias={storageAlias}
          displayAlias={storageAlias}
          isLiveCatalog={false}
          isCompatible={false}
          isAnthropic={false}
          isFreeNoAuth={!!noAuth}
          connections={conn.connections}
          catalogModels={staticModels}
          staticModels={staticModels}
          models={models}
          onDisableAll={(state) => conn.setConfirmState(state)}
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

      {!noAuth && (
        <AddApiKeyModal
          isOpen={showAddApiKey}
          provider={id}
          providerName={provider.name}
          isCompatible={false}
          isAnthropic={false}
          proxyPools={conn.proxyPools}
          error={addConnectionError}
          existingNames={conn.connections.map((entry) => entry.name).filter(Boolean)}
          onSave={saveApiKey}
          onClose={() => {
            setAddConnectionError("");
            setShowAddApiKey(false);
          }}
        />
      )}
      {!noAuth && (
        <EditConnectionModal
          isOpen={!!selectedConnection}
          connection={selectedConnection}
          proxyPools={conn.proxyPools}
          onSave={updateConnection}
          onClose={() => setSelectedConnection(null)}
        />
      )}
      {showModels && (
        <AddCustomModelModal
          kind={kind}
          isOpen={models.showAddCustomModel}
          providerAlias={storageAlias}
          providerDisplayAlias={storageAlias}
          onSave={saveCustomModel}
          onClose={() => models.setShowAddCustomModel(false)}
        />
      )}
      {/* ConnectionsSection owns this dialog; noAuth pages render NoAuthProxyCard instead. */}
      {noAuth && (
        <ConfirmDialog
          isOpen={!!conn.confirmState}
          onClose={() => conn.setConfirmState(null)}
          onConfirm={conn.confirmState?.onConfirm}
          title={conn.confirmState?.title || "Confirm"}
          message={conn.confirmState?.message}
          variant="danger"
        />
      )}
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
