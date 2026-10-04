"use client";

import PropTypes from "prop-types";
import { useMemo, useState } from "react";
import Callout from "@/shared/components/Callout";
import CopyField from "@/shared/components/CopyField";
import IconButton from "@/shared/components/IconButton";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";
import ApiKeySelect from "./ApiKeySelect";
import EndpointSegmentedPicker from "./EndpointSegmentedPicker";
import SetupScaffold, { SingleModelRow } from "./SetupScaffold";
import { manualApiKey } from "./setupCard";
import { useSetupSettings } from "../hooks/useSetupSettings";
import { getToolBrand } from "../lib/toolStatus";

const NOTE_VARIANT = { warning: "warn", cloudCheck: "err", error: "err", info: "info" };

/**
 * Guide-style setup panel for tools without a config-file writer
 * (Cursor, Roo, Continue, Amp, Qwen, Devin, OpenDesign, ...).
 * Renders the tool's guideSteps with the Signal primitives; var templates
 * ({{baseUrl}}, {{apiKey}}, {{model}}) resolve exactly as before. Model,
 * endpoint and API key persist via useSetupSettings (no disk).
 */
export default function DefaultToolCard({
  toolId,
  tool,
  baseUrl,
  apiKeys = [],
  activeProviders = [],
  cloudEnabled = false,
  cloudUrl = "",
  tunnelEnabled = false,
  tunnelPublicUrl = "",
  tailscaleEnabled = false,
  tailscaleUrl = "",
  modelAliases = {},
  hashedContext = false,
}) {
  const [showModelModal, setShowModelModal] = useState(false);
  const { copied, error, copy } = useCopyToClipboard();
  // YAN-363: guide cards have no per-route status, so the shared key context
  // is the hashed signal. Hashed: only a pasted key is templated — never the
  // brand default pretending to be one.
  const hashed = hashedContext;

  const defaults = useMemo(
    () => ({ model: tool.defaultModels?.[0]?.defaultValue || "", endpoint: "", apiKeyId: "" }),
    [tool.defaultModels],
  );
  const endpointContext = useMemo(
    () => ({
      tunnelEnabled,
      tunnelPublicUrl,
      tailscaleEnabled,
      tailscaleUrl,
      cloudEnabled,
      cloudUrl,
      requiresExternalUrl: tool.requiresExternalUrl,
    }),
    [
      tunnelEnabled,
      tunnelPublicUrl,
      tailscaleEnabled,
      tailscaleUrl,
      cloudEnabled,
      cloudUrl,
      tool.requiresExternalUrl,
    ],
  );
  const setup = useSetupSettings({ toolId, apiKeys, defaults, endpointContext });

  // The endpoint is only editable when the guide text actually uses {{baseUrl}}.
  const usesBaseUrl =
    tool.codeBlock?.code?.includes("{{baseUrl}}") ||
    (tool.guideSteps || []).some((s) => s.value?.includes("{{baseUrl}}"));

  const replaceVars = (text) => {
    const keyToUse = manualApiKey(setup.selectedApiKey, apiKeys, cloudEnabled, { hashed });
    const normalized = setup.endpoint || baseUrl || "http://localhost:20128";
    const withV1 = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
    return String(text)
      .replace(/\{\{baseUrl\}\}/g, withV1)
      .replace(/\{\{apiKey\}\}/g, keyToUse)
      .replace(/\{\{model\}\}/g, setup.model || "provider/model-id");
  };

  // Tailscale here is Funnel (public *.ts.net), so it reaches tools that call
  // the gateway from their own servers (Cursor) just like Tunnel does.
  // Mirrors buildEndpointOptions: an option only counts once its URL exists.
  const hasExternalUrl =
    (cloudEnabled && !!cloudUrl) ||
    (tunnelEnabled && !!tunnelPublicUrl) ||
    (tailscaleEnabled && !!tailscaleUrl);

  const canShowGuide = () => {
    if (tool.requiresExternalUrl && !hasExternalUrl) return false;
    if (tool.requiresCloud && !cloudEnabled) return false;
    return true;
  };

  const brand = getToolBrand(tool);

  const notes = (tool.notes || []).filter((n) => !(n.type === "cloudCheck" && hasExternalUrl));

  return (
    <SetupScaffold tool={tool} hideActions checking={!setup.loaded} {...setup.scaffoldProps("")}>
      {notes.map((note) => (
        <Callout key={`${note.type}-${note.text}`} variant={NOTE_VARIANT[note.type] || "info"}>
          {note.text}
        </Callout>
      ))}

      {tool.docsUrl && (
        <a
          href={tool.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="w-fit text-[13px] text-coral-ink underline hover:text-coral"
        >
          {tool.name} docs
        </a>
      )}

      {usesBaseUrl && (
        <EndpointSegmentedPicker
          key={setup.pickerKey}
          value={setup.endpoint || baseUrl}
          {...setup.pickerProps}
        />
      )}

      {!tool.guideSteps ? (
        <p className="text-sm text-muted">Coming soon...</p>
      ) : (
        canShowGuide() && (
          <ol className="flex list-none flex-col gap-4 p-0">
            {tool.guideSteps.map((item) => (
              <li key={item.step} className="flex items-start gap-3.5">
                <span
                  aria-hidden="true"
                  style={{ backgroundColor: brand.color }}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold text-white"
                >
                  {item.step}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <p className="text-sm font-semibold text-text">{item.title}</p>
                  {item.desc && <p className="text-[13px] text-muted">{item.desc}</p>}
                  {item.type === "apiKeySelector" && (
                    <div className="flex flex-col gap-1.5">
                      <ApiKeySelect
                        value={setup.selectedApiKey}
                        onChange={setup.onApiKeyChange}
                        apiKeys={apiKeys}
                        cloudEnabled={cloudEnabled}
                        hashed={hashed}
                      />
                      {hashed && !setup.selectedApiKey?.trim() && (
                        <span className="text-[11px] text-subtle">
                          Guide snippets need a pasted key — a stored one can't be shown.
                        </span>
                      )}
                    </div>
                  )}
                  {item.type === "modelSelector" && (
                    <SingleModelRow
                      value={setup.model}
                      onChange={setup.setModel}
                      onPick={() => setShowModelModal(true)}
                      pickDisabled={activeProviders.length === 0}
                    />
                  )}
                  {item.value && (
                    <CopyField
                      value={replaceVars(item.value)}
                      copyValue={replaceVars(item.value)}
                      label={`Copy ${item.title}`}
                    />
                  )}
                  {item.docsUrl && (
                    <a
                      href={item.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-fit text-[13px] text-coral-ink underline hover:text-coral"
                    >
                      Open docs
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )
      )}

      {canShowGuide() && tool.codeBlock && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            {tool.codeBlock.language}
          </span>
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-line bg-raised px-3 py-2.5 font-mono text-xs text-text">
              {replaceVars(tool.codeBlock.code)}
            </pre>
            <IconButton
              icon={
                copied === `toolcard-${toolId}`
                  ? "check"
                  : error === `toolcard-${toolId}`
                    ? "error"
                    : "content_copy"
              }
              label={error === `toolcard-${toolId}` ? "Couldn't copy snippet" : "Copy snippet"}
              onClick={() => copy(replaceVars(tool.codeBlock.code), `toolcard-${toolId}`)}
            />
            <CopyStatus copied={copied} error={error} id={`toolcard-${toolId}`} />
          </div>
        </div>
      )}

      {showModelModal && (
        <ModelSelectModal
          isOpen={showModelModal}
          onClose={() => setShowModelModal(false)}
          onSelect={(m) => {
            setup.setModel(m.value);
            setShowModelModal(false);
          }}
          selectedModel={setup.model}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Select model"
        />
      )}
    </SetupScaffold>
  );
}

DefaultToolCard.propTypes = {
  toolId: PropTypes.string.isRequired,
  tool: PropTypes.shape({
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
    notes: PropTypes.array,
    guideSteps: PropTypes.array,
    docsUrl: PropTypes.string,
    codeBlock: PropTypes.object,
    defaultModels: PropTypes.array,
    requiresExternalUrl: PropTypes.bool,
    requiresCloud: PropTypes.bool,
  }).isRequired,
  baseUrl: PropTypes.string,
  apiKeys: PropTypes.array,
  activeProviders: PropTypes.array,
  cloudEnabled: PropTypes.bool,
  cloudUrl: PropTypes.string,
  tunnelEnabled: PropTypes.bool,
  tunnelPublicUrl: PropTypes.string,
  tailscaleEnabled: PropTypes.bool,
  tailscaleUrl: PropTypes.string,
  modelAliases: PropTypes.object,
};
