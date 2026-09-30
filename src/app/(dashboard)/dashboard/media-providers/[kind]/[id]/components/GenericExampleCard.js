"use client";

import PropTypes from "prop-types";
import { Card } from "@/shared/components";
import { useGenericExample } from "./useGenericExample";
import { GenericExampleForm } from "./GenericExampleForm";
import { GenericExampleResult } from "./GenericExampleResult";

/**
 * Live generic media example (image/video/music/web kinds) for a provider
 * detail page (YAN-402). Composition only: state lives in
 * `useGenericExample`, rows in `GenericExampleForm`, the result view in
 * `GenericExampleResult`.
 */
export function GenericExampleCard({ providerId, kind }) {
  const example = useGenericExample(providerId, kind);
  const {
    kindConfig,
    exConfig,
    safeProviderAlias,
    kindModels,
    allowManualModel,
    selectedModel,
    setSelectedModel,
    selectedModelObj,
    supportsEdit,
    supportsMask,
    input,
    setInput,
    refImage,
    setRefImage,
    maskImage,
    setMaskImage,
    extraValues,
    setExtraValues,
    apiKey,
    useTunnel,
    setUseTunnel,
    endpoint,
    tunnelEndpoint,
    result,
    progress,
    partialImage,
    imageOutputFormat,
    setImageOutputFormat,
    binaryImageUrl,
    running,
    error,
    connections,
    pinnedConnectionId,
    setPinnedConnectionId,
    refImagePreviewSrc,
    maskImagePreviewSrc,
    imageEditDefaults,
    useStreaming,
    modelFull,
    curlSnippet,
    resultJson,
    handleRun,
  } = example;

  // Safe to render nothing now that all hooks are declared (hook declares every hook first).
  if (!kindConfig || !exConfig) return null;

  const apiPath = kindConfig.endpoint.path;

  return (
    <Card
      title={`${safeProviderAlias} example`}
      subtitle={`Run a live ${kindConfig.label.toLowerCase()} request against this provider.`}
      icon="labs"
    >
      <div className="flex flex-col gap-2.5">
        <GenericExampleForm
          kind={kind}
          kindModels={kindModels}
          allowManualModel={allowManualModel}
          selectedModel={selectedModel}
          onSelectModel={setSelectedModel}
          exConfig={exConfig}
          selectedModelObj={selectedModelObj}
          endpoint={endpoint}
          apiPath={apiPath}
          tunnelEndpoint={tunnelEndpoint}
          useTunnel={useTunnel}
          onToggleTunnel={() => setUseTunnel((v) => !v)}
          apiKey={apiKey}
          connections={connections}
          pinnedConnectionId={pinnedConnectionId}
          onPinConnection={setPinnedConnectionId}
          input={input}
          onInputChange={setInput}
          supportsEdit={supportsEdit}
          refImage={refImage}
          onRefImageChange={setRefImage}
          refImagePreviewSrc={refImagePreviewSrc}
          imageEditDefaults={imageEditDefaults}
          supportsMask={supportsMask}
          maskImage={maskImage}
          onMaskImageChange={setMaskImage}
          maskImagePreviewSrc={maskImagePreviewSrc}
          extraValues={extraValues}
          onExtraChange={(key, value) => setExtraValues((s) => ({ ...s, [key]: value }))}
          imageOutputFormat={imageOutputFormat}
          onOutputFormatChange={setImageOutputFormat}
          curlSnippet={curlSnippet}
          running={running}
          canRun={!!input.trim() && !!modelFull}
          onRun={handleRun}
        />

        <GenericExampleResult
          kind={kind}
          running={running}
          progress={progress}
          useStreaming={useStreaming}
          partialImage={partialImage}
          result={result}
          binaryImageUrl={binaryImageUrl}
          resultJson={resultJson}
          defaultResponse={exConfig.defaultResponse}
          error={error}
        />
      </div>
    </Card>
  );
}

GenericExampleCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  kind: PropTypes.string.isRequired,
};
