"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { selectModelsToImport } from "@/shared/utils/liveModels";

/** Refreshes the live catalog and imports models not already available. */
export default function FetchModelsButton({
  providerId,
  refresh,
  staticModels,
  customModels,
  modelAliases,
  providerStorageAlias,
  onAddModel,
}) {
  const [fetching, setFetching] = useState(false);

  const handleClick = async () => {
    if (fetching) return;
    setFetching(true);
    const notify = useNotificationStore.getState();
    try {
      const { models, warning } = await refresh();
      if (!models.length) {
        notify.error(warning ? `No models returned: ${warning}` : "No models returned");
        return;
      }

      const ids = selectModelsToImport({
        providerId,
        liveModels: models,
        staticModels,
        customModels,
        modelAliases,
        providerStorageAlias,
      });
      let imported = 0;
      // Sequential on purpose: each add refetches the custom model list.
      for (const id of ids) {
        if (await onAddModel(id)) imported += 1;
      }
      if (ids.length === 0) notify.info("All models already exist. No new models added.");
      else if (imported === ids.length)
        notify.success(`Added ${imported} model${imported === 1 ? "" : "s"}.`);
      else
        notify.error(`Added ${imported} of ${ids.length} models; ${ids.length - imported} failed.`);
    } catch (error) {
      notify.error(
        `Could not fetch models: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setFetching(false);
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      icon="download"
      loading={fetching}
      onClick={handleClick}
    >
      {fetching ? "Fetching…" : "Fetch models"}
    </Button>
  );
}

FetchModelsButton.propTypes = {
  providerId: PropTypes.string.isRequired,
  refresh: PropTypes.func.isRequired,
  staticModels: PropTypes.array.isRequired,
  customModels: PropTypes.array.isRequired,
  modelAliases: PropTypes.object.isRequired,
  providerStorageAlias: PropTypes.string.isRequired,
  onAddModel: PropTypes.func.isRequired,
};
