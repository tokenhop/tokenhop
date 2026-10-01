"use client";

import PropTypes from "prop-types";
import { useEffect, useRef, useState } from "react";
import Callout from "@/shared/components/Callout";
import CopyField from "@/shared/components/CopyField";
import IconButton from "@/shared/components/IconButton";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";
import ApiKeySelect from "./ApiKeySelect";
import SetupScaffold, { SingleModelRow } from "./SetupScaffold";
import { getToolBrand } from "../lib/toolStatus";
import { ACTIVE } from "@/shared/brand";

const NOTE_VARIANT = { warning: "warn", cloudCheck: "err", info: "info" };

/**
 * Guide-style setup panel for tools without a config-file writer
 * (Cursor, Roo, Continue, Amp, Qwen, Devin, OpenDesign, ...).
 * Renders the tool's guideSteps with the Signal primitives; var templates
 * ({{baseUrl}}, {{apiKey}}, {{model}}) resolve exactly as before.
 */
export default function DefaultToolCard({
  toolId,
  tool,
  baseUrl,
  apiKeys = [],
  activeProviders = [],
  cloudEnabled = false,
  tunnelEnabled = false,
}) {
  const [modelValue, setModelValue] = useState("");
  const [showModelModal, setShowModelModal] = useState(false);
  const [selectedApiKey, setSelectedApiKey] = useState(() =>
    apiKeys?.length > 0 ? apiKeys[0].key : "",
  );
  const { copied, error, copy } = useCopyToClipboard();

  const replaceVars = (text) => {
    const keyToUse =
      selectedApiKey?.trim() || (!cloudEnabled ? ACTIVE.defaultApiKey : "your-api-key");
    const normalized = baseUrl || "http://localhost:20128";
    const withV1 = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
    return String(text)
      .replace(/\{\{baseUrl\}\}/g, withV1)
      .replace(/\{\{apiKey\}\}/g, keyToUse)
      .replace(/\{\{model\}\}/g, modelValue || "provider/model-id");
  };

  const canShowGuide = () => {
    if (tool.requiresExternalUrl && !cloudEnabled && !tunnelEnabled) return false;
    if (tool.requiresCloud && !cloudEnabled) return false;
    return true;
  };

  const brand = getToolBrand(tool);

  const notes = (tool.notes || []).filter(
    (n) => !(n.type === "cloudCheck" && (cloudEnabled || tunnelEnabled)),
  );

  return (
    <SetupScaffold tool={tool} hideActions fileHint="">
      {notes.map((note) => (
        <Callout key={`${note.type}-${note.text}`} variant={NOTE_VARIANT[note.type] || "info"}>
          {note.text}
        </Callout>
      ))}

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
                    <ApiKeySelect
                      value={selectedApiKey}
                      onChange={setSelectedApiKey}
                      apiKeys={apiKeys}
                      cloudEnabled={cloudEnabled}
                    />
                  )}
                  {item.type === "modelSelector" && (
                    <SingleModelRow
                      value={modelValue}
                      onChange={setModelValue}
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
            setModelValue(m.value);
            setShowModelModal(false);
          }}
          selectedModel={modelValue}
          activeProviders={activeProviders}
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
    codeBlock: PropTypes.object,
    requiresExternalUrl: PropTypes.bool,
    requiresCloud: PropTypes.bool,
  }).isRequired,
  baseUrl: PropTypes.string,
  apiKeys: PropTypes.array,
  activeProviders: PropTypes.array,
  cloudEnabled: PropTypes.bool,
  tunnelEnabled: PropTypes.bool,
};
