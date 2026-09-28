"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import {
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  AI_PROVIDERS,
} from "@/shared/constants/providers";
import Select from "@/shared/components/Select";
import WeightedConnectionFields from "@/shared/components/WeightedConnectionFields";
import { formatPlanTier } from "@/shared/constants/accountStrategies";
import { PLAN_CAPACITY } from "open-sse/config/quotaSnapshot.js";

export default function EditConnectionModal({ isOpen, connection, onSave, onClose }) {
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    apiKey: "",
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [region, setRegion] = useState("");
  const [planTier, setPlanTier] = useState("");
  const [weightOverride, setWeightOverride] = useState("");
  const [weightError, setWeightError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);
  // Bumped whenever a validation input changes; a check started under an older
  // sequence no longer describes the form and its result is discarded.
  const validationSeq = useRef(0);

  // Re-seed on every open too: the modal stays mounted, so reopening the same
  // connection must not show a previous session's key or check result.
  useEffect(() => {
    if (connection && isOpen) {
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        apiKey: "",
      });
      setPlanTier(
        connection.providerSpecificData?.planTierManual
          ? connection.providerSpecificData.planTier || ""
          : "",
      );
      setWeightOverride(
        connection.providerSpecificData?.weight == null
          ? ""
          : String(connection.providerSpecificData.weight),
      );
      setWeightError("");
      setSaveError("");
      // Load Azure-specific data if present
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      // Load region for providers that support it (e.g. xiaomi-tokenplan)
      const providerCfg = AI_PROVIDERS?.[connection.provider];
      if (providerCfg?.regions) {
        const savedRegion =
          connection.providerSpecificData?.region ||
          providerCfg.defaultRegion ||
          providerCfg.regions[0]?.id ||
          "";
        setRegion(savedRegion);
      }
      setTestResult(null);
      setValidationResult(null);
    }
  }, [connection, isOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the validation inputs by design
  useEffect(() => {
    validationSeq.current += 1;
    setValidationResult(null);
  }, [formData.apiKey, azureData, cloudflareData, region]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const isCompatible = connection
    ? isOpenAICompatibleProvider(connection.provider) ||
      isAnthropicCompatibleProvider(connection.provider)
    : false;
  const providerRegions = connection ? AI_PROVIDERS?.[connection.provider]?.regions || null : null;
  const psd = connection?.providerSpecificData || {};
  const planOptions = connection ? PLAN_CAPACITY[connection.provider] : undefined;
  const autoPlanLabel =
    psd.planTier && !psd.planTierManual
      ? `Auto-detected: ${formatPlanTier(psd.planTier)}`
      : "Auto (not detected yet)";

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { ...(connection?.providerSpecificData || {}), region };
    return undefined;
  };

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
      const data = await res.json();
      setTestResult(data.valid ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider || !formData.apiKey) return;
    const seq = validationSeq.current;
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          apiKey: formData.apiKey,
          ...(isAzure ? { providerSpecificData: azureData } : {}),
          ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
          ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
        }),
      });
      const data = await res.json();
      if (validationSeq.current === seq) setValidationResult(data.valid ? "success" : "failed");
    } catch {
      if (validationSeq.current === seq) setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  // Only changed weighted fields are sent; null clears a previously stored value.
  const buildWeightedData = () => {
    const data = {};
    if (planOptions) {
      if (planTier) {
        if (!(psd.planTierManual && psd.planTier === planTier)) {
          data.planTier = planTier;
          data.planTierManual = true;
        }
      } else if (psd.planTierManual) {
        data.planTier = null;
        data.planTierManual = null;
      }
    }
    const trimmedWeight = weightOverride.trim();
    if (trimmedWeight) {
      const weight = Number(trimmedWeight);
      if (weight !== psd.weight) data.weight = weight;
    } else if (psd.weight != null) {
      data.weight = null;
    }
    return data;
  };

  const handleSubmit = async () => {
    if (!connection) return;
    const trimmedWeight = weightOverride.trim();
    const weight = Number(trimmedWeight);
    if (trimmedWeight && !(Number.isFinite(weight) && weight >= 0 && weight <= 1000)) {
      setWeightError("Weight must be a number from 0 to 1000");
      return;
    }
    setWeightError("");
    setSaveError("");
    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        // Always revalidate the submitted key; a prior check may belong to another key.
        const seq = validationSeq.current;
        let isValid = false;
        try {
          setValidating(true);
          setValidationResult(null);
          const res = await fetch("/api/providers/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: connection.provider,
              apiKey: formData.apiKey,
              ...(isAzure ? { providerSpecificData: azureData } : {}),
              ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
              ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
            }),
          });
          const data = await res.json();
          isValid = !!data.valid;
          if (validationSeq.current === seq) setValidationResult(isValid ? "success" : "failed");
        } catch {
          if (validationSeq.current === seq) setValidationResult("failed");
        } finally {
          setValidating(false);
        }
        // A failed check must not leave a replaced key labelled with the old status.
        updates.testStatus = isValid ? "active" : "unknown";
        updates.lastError = null;
        updates.lastErrorAt = null;
      }

      // Add Azure-specific data if this is an Azure connection
      if (isAzure) {
        updates.providerSpecificData = {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        };
      }
      if (isCloudflareAi) {
        updates.providerSpecificData = { accountId: cloudflareData.accountId };
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        updates.providerSpecificData = buildRegionSpecificData();
      }
      // Merge weighted overrides last so provider-specific branches above are kept.
      const weighted = buildWeightedData();
      if (Object.keys(weighted).length > 0) {
        updates.providerSpecificData = { ...updates.providerSpecificData, ...weighted };
      }

      const error = await onSave(updates);
      if (error) setSaveError(error);
    } catch {
      setSaveError("Failed to save connection");
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="rounded-lg bg-raised p-3">
            <p className="mb-1 text-sm text-muted">Email</p>
            <p className="font-medium text-text">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) =>
            setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })
          }
        />

        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button
                  onClick={handleValidate}
                  disabled={!formData.apiKey || validating || saving}
                  variant="secondary"
                >
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
          </>
        )}

        {isAzure && (
          <div className="rounded-lg border border-coral/20 bg-raised p-4">
            <h3 className="mb-3 text-sm font-semibold text-text">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}

        <WeightedConnectionFields
          planOptions={planOptions}
          planTier={planTier}
          onPlanTierChange={setPlanTier}
          autoPlanLabel={autoPlanLabel}
          weight={weightOverride}
          onWeightChange={(value) => {
            setWeightOverride(value);
            setWeightError("");
          }}
          weightError={weightError}
        />

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

        {saveError && (
          <p className="text-sm text-err" role="alert">
            {saveError}
          </p>
        )}
        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
