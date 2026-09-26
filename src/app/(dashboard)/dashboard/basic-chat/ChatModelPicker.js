"use client";

import PropTypes from "prop-types";
import { useCallback, useRef } from "react";
import { Skeleton, StatusPill } from "@/shared/components";
import ProviderTile from "@/shared/components/ProviderTile";
import { cn } from "@/shared/utils/cn";
import useMenuDismiss from "./useMenuDismiss";

const MENU_ID = "basic-chat-model-menu";

/** Model menu for basic chat: models grouped by provider, coral selection, skeleton label while loading. */
export default function ChatModelPicker({
  providerGroups,
  activeModel,
  activeModelId,
  loadingData,
  isOpen,
  onOpenChange,
  onSelectModel,
}) {
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useMenuDismiss(isOpen, close, triggerRef, panelRef);

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? MENU_ID : undefined}
        onClick={() => onOpenChange(!isOpen)}
        className="flex min-h-11 max-w-full items-center gap-3 rounded-xl border border-line bg-panel px-4 py-2 text-start shadow-card transition-colors hover:bg-raised focus-visible:shadow-focus focus-visible:outline-none"
      >
        {loadingData && !activeModel ? (
          <span className="flex w-48 flex-col gap-1.5" role="status" aria-label="Loading models">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-44" />
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-3">
            {activeModel?.providerId && (
              <ProviderTile providerId={activeModel.providerId} size="md" />
            )}
            <span className="min-w-0">
              <span className="block truncate font-display text-sm font-semibold text-text">
                {activeModel ? activeModel.name : "Select model"}
              </span>
              <span className="block truncate font-mono text-xs text-subtle">
                {activeModel ? activeModel.requestModel : "Choose from connected providers"}
              </span>
            </span>
          </span>
        )}
        <span
          className={cn(
            "material-symbols-outlined shrink-0 text-[20px] text-muted transition-transform",
            isOpen && "rotate-180",
          )}
          aria-hidden="true"
        >
          expand_more
        </span>
      </button>

      {isOpen ? (
        <div
          ref={panelRef}
          id={MENU_ID}
          role="dialog"
          aria-label="Models"
          className="signal-overlay-menu absolute start-0 top-[calc(100%+8px)] z-30 w-[min(520px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-panel shadow-card"
        >
          <div className="border-b border-line px-4 py-3">
            <p className="font-mono text-xs uppercase tracking-wider text-subtle">Models</p>
            <p className="text-sm text-muted">Only from connected providers</p>
          </div>
          <div className="custom-scrollbar max-h-[60vh] overflow-y-auto p-2">
            {providerGroups.map((group) => (
              <section
                key={group.providerId}
                aria-label={group.providerName}
                className="mb-2 rounded-xl border border-line bg-raised p-2 last:mb-0"
              >
                <div className="flex items-center justify-between gap-2 px-2 py-2">
                  <ProviderTile providerId={group.providerId} size="sm" />
                  <p className="me-auto font-display text-sm font-semibold text-text">
                    {group.providerName}
                  </p>
                  <StatusPill variant="neutral" size="sm">
                    {group.models.length} {group.models.length === 1 ? "model" : "models"}
                  </StatusPill>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.models.map((model) => {
                    const isActive = model.id === activeModelId;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => onSelectModel(model.id)}
                        className={cn(
                          "flex min-h-11 items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-start transition-colors focus-visible:shadow-focus focus-visible:outline-none",
                          isActive
                            ? "border-coral bg-coral-bg"
                            : "border-line bg-panel hover:bg-bg",
                        )}
                      >
                        <span className="min-w-0">
                          <span
                            className={cn(
                              "block truncate text-sm font-medium",
                              isActive ? "text-coral-ink" : "text-text",
                            )}
                          >
                            {model.name}
                          </span>
                          <span className="block truncate font-mono text-xs text-subtle">
                            {model.requestModel}
                          </span>
                        </span>
                        {isActive ? (
                          <span
                            className="material-symbols-outlined shrink-0 text-[18px] text-coral"
                            aria-hidden="true"
                          >
                            check_circle
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const modelShape = PropTypes.shape({
  id: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  requestModel: PropTypes.string.isRequired,
  providerId: PropTypes.string,
});

ChatModelPicker.propTypes = {
  providerGroups: PropTypes.arrayOf(
    PropTypes.shape({
      providerId: PropTypes.string.isRequired,
      providerName: PropTypes.string.isRequired,
      models: PropTypes.arrayOf(modelShape).isRequired,
    }),
  ).isRequired,
  activeModel: modelShape,
  activeModelId: PropTypes.string.isRequired,
  loadingData: PropTypes.bool.isRequired,
  isOpen: PropTypes.bool.isRequired,
  onOpenChange: PropTypes.func.isRequired,
  onSelectModel: PropTypes.func.isRequired,
};
