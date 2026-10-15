import { useRef, useState } from "react";
import Card from "@/shared/components/Card";
import ModelRow from "@/app/(dashboard)/dashboard/providers/[id]/ModelRow";
import { scheduleRefresh } from "./list-fixture.jsx";
import ModelsSection from "@/app/(dashboard)/dashboard/providers/detail/ModelsSection";
import CompatibleModelsSection from "@/app/(dashboard)/dashboard/providers/detail/CompatibleModelsSection";

const noop = () => {};
/** Fake useModels data, real owner section, real rows, real move dialog. */
export function ModelsFixture({ entry }) {
  const [moved, setMoved] = useState(false);
  const target = useRef(null);
  const row = {
    id: "custom-second",
    name: "Custom second",
    source: "custom",
    fullModel: "prov/custom-second",
  };
  const models = {
    modelAliases: entry === "alias" && !moved ? { "second-alias": "prov/second-model" } : {},
    customModels:
      (entry === "custom" || entry === "compatible") && !moved
        ? [{ id: "custom-second", providerAlias: "prov", kind: "llm" }]
        : [],
    customModelRows: entry === "custom" && !moved ? [row] : [],
    enabledModels: entry === "alias" ? [{ id: "second-model" }] : [],
    disabledModels: entry === "disabled" && !moved ? [{ id: "second-model" }] : [],
    disabledModelIds: entry === "disabled" && !moved ? ["second-model"] : [],
    suggestedModels: [],
    testResults: {},
    testingIds: new Set(),
    thinkingMode: "auto",
    testError: "",
    load: () => scheduleRefresh(() => setMoved(true)),
    changeThinking: noop,
    setShowAddCustomModel: noop,
    disableAll: noop,
    enableAll: noop,
    testModel: noop,
    deleteCustomModel: noop,
    deleteAlias: noop,
    setAlias: noop,
    addCustomModel: noop,
    disableModel: noop,
    enableModel: noop,
  };
  // Direct ModelRow fixture additionally verifies its public ref handoff.
  if (entry === "model-row")
    return (
      <Card title="Available models" headingRef={target}>
        {!moved ? (
          <ul>
            <ModelRow
              model={{ id: "custom-second" }}
              fullModel="prov/custom-second"
              copied={null}
              onCopy={noop}
              moveItem={{ type: "customModel", id: "prov|custom-second|llm" }}
              successFocusRef={target}
              onMoved={models.load}
            />
          </ul>
        ) : null}
        <button type="button">Add model</button>
      </Card>
    );
  return (
    <div data-testid="model-owner" data-moved={moved}>
      <ModelsSection
        providerId="openai"
        storageAlias="prov"
        displayAlias="prov"
        isLiveCatalog={false}
        isCompatible={entry === "compatible"}
        isAnthropic={false}
        isFreeNoAuth={false}
        connections={[]}
        catalogModels={[]}
        staticModels={[]}
        models={models}
        onDisableAll={noop}
        compatibleSection={
          <CompatibleModelsSection
            isFreeNoAuth={false}
            storageAlias="prov"
            displayAlias="prov"
            isAnthropic={false}
            connections={[]}
            models={models}
            actions={{ notifyError: noop }}
            successFocusRef={target}
          />
        }
        // Section owns its heading by default; supplying the ref shares it with
        // the externally composed CompatibleModelsSection, just as the page does.
        headingRef={target}
      />
    </div>
  );
}
