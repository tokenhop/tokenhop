"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Callout, Modal, Toggle } from "@/shared/components";
import { CAPACITY_META } from "@/shared/constants/models";

const defaultCaps = () => Object.fromEntries(Object.keys(CAPACITY_META).map((key) => [key, false]));

export default function AddCustomModelModal({
  isOpen,
  providerAlias,
  providerDisplayAlias,
  onSave,
  onClose,
}) {
  const [modelId, setModelId] = useState("");
  const [caps, setCaps] = useState(defaultCaps);
  const [testStatus, setTestStatus] = useState(null); // null | "testing" | "ok" | "error"
  const [testError, setTestError] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setModelId("");
      setCaps(defaultCaps());
      setTestStatus(null);
      setTestError("");
    }
  }, [isOpen]);

  // Strip provider's own alias prefix (e.g. "cc/model" -> "model" for cc provider)
  const stripAlias = (id) => {
    const prefix = `${providerAlias}/`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  };

  const handleTest = async () => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId) return;
    setTestStatus("testing");
    setTestError("");
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerAlias}/${cleanId}` }),
      });
      const data = await res.json();
      setTestStatus(res.ok && data.ok ? "ok" : "error");
      setTestError(data.error || (res.ok && data.ok ? "" : "Model not reachable"));
    } catch (err) {
      setTestStatus("error");
      setTestError(err.message);
    }
  };

  const handleSave = async () => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId || saving) return;
    setSaving(true);
    try {
      await onSave(cleanId, caps);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleTest();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add custom model">
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium mb-1.5 block">Model ID</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={modelId}
              onChange={(e) => {
                setModelId(e.target.value);
                setTestStatus(null);
                setTestError("");
              }}
              onKeyDown={handleKeyDown}
              placeholder="e.g. claude-opus-4-5"
              className="flex-1 px-3 py-2 text-sm border border-line rounded-lg bg-raised focus:outline-none focus:border-coral"
              autoFocus
            />
            <Button
              variant="secondary"
              icon="science"
              loading={testStatus === "testing"}
              onClick={handleTest}
              disabled={!modelId.trim() || testStatus === "testing"}
            >
              {testStatus === "testing" ? "Testing..." : "Test"}
            </Button>
          </div>
          <p className="text-xs text-muted mt-1">
            Sent to provider as:{" "}
            <code className="font-mono bg-panel px-1 rounded">
              {stripAlias(modelId.trim()) || "model-id"}
            </code>
          </p>
        </div>

        <div>
          <label className="text-sm font-medium mb-1.5 block">Capabilities</label>
          <div className="flex flex-wrap gap-4">
            {Object.entries(CAPACITY_META).map(([key, meta]) => (
              <Toggle
                key={key}
                checked={!!caps[key]}
                onChange={(v) => setCaps((prev) => ({ ...prev, [key]: v }))}
                label={meta.label}
                description={meta.desc}
                size="sm"
              />
            ))}
          </div>
        </div>

        {/* Test result */}
        {testStatus === "ok" && <Callout variant="ok">Model is reachable</Callout>}
        {testStatus === "error" && (
          <Callout variant="err">{testError || "Model not reachable"}</Callout>
        )}

        <div className="flex gap-2 pt-1">
          <Button onClick={onClose} variant="ghost" fullWidth size="sm">
            Cancel
          </Button>
          <Button onClick={handleSave} fullWidth size="sm" disabled={!modelId.trim() || saving}>
            {saving ? "Adding…" : "Add model"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AddCustomModelModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
