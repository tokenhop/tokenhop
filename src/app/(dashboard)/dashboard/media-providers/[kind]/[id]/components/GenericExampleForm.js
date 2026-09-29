"use client";

import PropTypes from "prop-types";
import { IconButton } from "@/shared/components";
import { maskPreviewApiKey } from "@/shared/constants/previewAuth";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  Row,
  controlClass,
  readonlyClass,
  tunnelToggleClass,
  ExampleRequestBlock,
} from "./exampleShared";
import { visibleExtraFields } from "./genericExampleLogic";
import { ImageUrlField, ExtraFieldControl } from "./GenericExampleFields";

/**
 * Generic media example form rows (YAN-402): model, endpoint/key,
 * connection, input, ref/mask images, extra fields and output format.
 * Pure presentation — state lives in `useGenericExample`.
 */
export function GenericExampleForm({
  kind,
  kindModels,
  allowManualModel,
  selectedModel,
  onSelectModel,
  exConfig,
  selectedModelObj,
  endpoint,
  apiPath,
  tunnelEndpoint,
  useTunnel,
  onToggleTunnel,
  apiKey,
  connections,
  pinnedConnectionId,
  onPinConnection,
  input,
  onInputChange,
  supportsEdit,
  refImage,
  onRefImageChange,
  refImagePreviewSrc,
  imageEditDefaults,
  supportsMask,
  maskImage,
  onMaskImageChange,
  maskImagePreviewSrc,
  extraValues,
  onExtraChange,
  imageOutputFormat,
  onOutputFormatChange,
  curlSnippet,
  running,
  canRun,
  onRun,
}) {
  const { copied: copiedCurl, error: errorCurl, copy: copyCurl } = useCopyToClipboard();

  return (
    <>
      {/* Model selector — dropdown if presets exist, else manual input for media kinds */}
      {kindModels.length > 0 ? (
        <Row label="Model">
          <select
            value={selectedModel}
            onChange={(e) => onSelectModel(e.target.value)}
            aria-label="Model"
            className={controlClass}
          >
            {kindModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </select>
        </Row>
      ) : allowManualModel ? (
        <Row label="Model">
          <input
            value={selectedModel}
            onChange={(e) => onSelectModel(e.target.value)}
            placeholder="Enter model id (provider-specific)"
            aria-label="Model"
            className={`${controlClass} font-mono`}
          />
        </Row>
      ) : null}

      {/* Endpoint */}
      <Row label="Endpoint">
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <span className={readonlyClass} dir="ltr">
            {endpoint}
            {apiPath}
          </span>
          {tunnelEndpoint && (
            <button
              type="button"
              onClick={onToggleTunnel}
              title={useTunnel ? "Using tunnel" : "Using local"}
              aria-pressed={useTunnel}
              className={tunnelToggleClass(useTunnel)}
            >
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                wifi_tethering
              </span>
              Tunnel
            </button>
          )}
        </div>
      </Row>

      {/* API Key */}
      <Row label="API Key">
        <span className={readonlyClass} dir="ltr">
          {apiKey ? (
            maskPreviewApiKey(apiKey)
          ) : (
            <span className="text-subtle italic">No key configured</span>
          )}
        </span>
      </Row>

      {/* Connection picker - only show when 2+ connections (or any with email) */}
      {connections.length > 0 && (
        <Row label="Connection">
          <select
            value={pinnedConnectionId}
            onChange={(e) => onPinConnection(e.target.value)}
            aria-label="Connection"
            className={controlClass}
          >
            <option value="">Auto (by priority)</option>
            {connections.map((c) => {
              const plan = c.providerSpecificData?.chatgptPlanType;
              const label = c.email || c.name || c.id.slice(0, 8);
              return (
                <option key={c.id} value={c.id}>
                  {label}
                  {plan ? ` [${plan}]` : ""}
                </option>
              );
            })}
          </select>
        </Row>
      )}

      {/* Input */}
      <Row label={exConfig.inputLabel}>
        <div className="relative">
          <input
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={exConfig.inputPlaceholder}
            aria-label={exConfig.inputLabel}
            className={`${controlClass} pe-11`}
          />
          {input && (
            <IconButton
              icon="close"
              label={`Clear ${exConfig.inputLabel.toLowerCase()}`}
              onClick={() => onInputChange("")}
              className="absolute end-1 top-1/2 size-9 -translate-y-1/2 border-0 bg-transparent"
            />
          )}
        </div>
      </Row>

      {/* Reference image (only for edit-capable image models) */}
      {supportsEdit && (
        <ImageUrlField
          label="Ref Image (URL)"
          value={refImage}
          onChange={onRefImageChange}
          placeholder={imageEditDefaults.image || "https://example.com/source.png"}
          previewSrc={refImagePreviewSrc}
          clearLabel="Clear reference image"
          alt="Reference"
        />
      )}

      {supportsMask && (
        <ImageUrlField
          label="Mask (URL)"
          value={maskImage}
          onChange={onMaskImageChange}
          placeholder={imageEditDefaults.mask_image || "https://example.com/mask.png"}
          previewSrc={maskImagePreviewSrc}
          clearLabel="Clear mask image"
          alt="Mask"
        />
      )}

      {/* Extra fields — for kinds without model concept (webSearch/webFetch), show all; otherwise filter by model.params */}
      {visibleExtraFields(exConfig.extraFields, kindModels, selectedModelObj).map((f) => (
        <Row key={f.key} label={f.label}>
          <ExtraFieldControl
            field={f}
            value={extraValues[f.key]}
            onChange={(value) => onExtraChange(f.key, value)}
          />
        </Row>
      ))}

      {/* Output Format toggle (image only) — last */}
      {kind === "image" && (
        <Row label="Output Format">
          <select
            value={imageOutputFormat}
            onChange={(e) => onOutputFormatChange(e.target.value)}
            aria-label="Output Format"
            className={controlClass}
          >
            <option value="json">JSON (Base64)</option>
            <option value="binary">Binary File</option>
          </select>
        </Row>
      )}

      <ExampleRequestBlock
        curlSnippet={curlSnippet}
        running={running}
        runningLabel="Running..."
        canRun={canRun}
        onRun={onRun}
        copied={copiedCurl}
        copyError={errorCurl}
        onCopy={() => copyCurl(curlSnippet)}
      />
    </>
  );
}

GenericExampleForm.propTypes = {
  kind: PropTypes.string.isRequired,
  kindModels: PropTypes.array,
  allowManualModel: PropTypes.bool,
  selectedModel: PropTypes.string,
  onSelectModel: PropTypes.func.isRequired,
  exConfig: PropTypes.object.isRequired,
  selectedModelObj: PropTypes.object,
  endpoint: PropTypes.string,
  apiPath: PropTypes.string,
  tunnelEndpoint: PropTypes.string,
  useTunnel: PropTypes.bool,
  onToggleTunnel: PropTypes.func.isRequired,
  apiKey: PropTypes.string,
  connections: PropTypes.array,
  pinnedConnectionId: PropTypes.string,
  onPinConnection: PropTypes.func.isRequired,
  input: PropTypes.string,
  onInputChange: PropTypes.func.isRequired,
  supportsEdit: PropTypes.bool,
  refImage: PropTypes.string,
  onRefImageChange: PropTypes.func.isRequired,
  refImagePreviewSrc: PropTypes.string,
  imageEditDefaults: PropTypes.object,
  supportsMask: PropTypes.bool,
  maskImage: PropTypes.string,
  onMaskImageChange: PropTypes.func.isRequired,
  maskImagePreviewSrc: PropTypes.string,
  extraValues: PropTypes.object,
  onExtraChange: PropTypes.func.isRequired,
  imageOutputFormat: PropTypes.string,
  onOutputFormatChange: PropTypes.func.isRequired,
  curlSnippet: PropTypes.string.isRequired,
  running: PropTypes.bool,
  canRun: PropTypes.bool,
  onRun: PropTypes.func.isRequired,
};
