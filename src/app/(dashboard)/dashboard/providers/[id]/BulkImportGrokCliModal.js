"use client";
import { withOAuthWorkspace } from "@/shared/utils/oauthWorkspace";

import { useState, useRef } from "react";
import { Modal, Button, Callout, StatusPill } from "@/shared/components";
import { translate } from "@/i18n/runtime";

const PLACEHOLDER = `[
  {
    "access_token": "eyJ0eXAiOiJhdCtqd3Qi...",
    "refresh_token": "LZhriF9bf88pPykpXCuZ9...",
    "id_token": "eyJ0eXAiOiJKV1QiLCJhbGci...",
    "email": "account1@example.com"
  },
  {
    "access_token": "eyJ0eXAiOiJhdCtqd3Qi...",
    "refresh_token": "LZhriF9bf88pPykpXCuZ9...",
    "id_token": "eyJ0eXAiOiJKV1QiLCJhbGci...",
    "email": "account2@example.com"
  }
]`;

function parseAccountsInput(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (initialErr) {
    // If direct parse failed, try handling concatenated or comma-separated JSON objects
    try {
      let fixed = trimmed;
      if (!fixed.startsWith("[")) {
        fixed = fixed.replace(/\}\s*,\s*\{/g, "},{").replace(/\}\s*\{/g, "},{");
        if (fixed.endsWith(",")) fixed = fixed.slice(0, -1);
        fixed = `[${fixed}]`;
      }
      parsed = JSON.parse(fixed);
    } catch {
      throw initialErr;
    }
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.accounts)) return parsed.accounts;
    return [parsed];
  }

  throw new Error("Input must be a JSON object or array of objects");
}

export default function BulkImportGrokCliModal({ isOpen, onClose, onSuccess, workspaceId = null }) {
  const [jsonText, setJsonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [parseError, setParseError] = useState("");
  const [result, setResult] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [fileCountInfo, setFileCountInfo] = useState(null);
  const fileInputRef = useRef(null);

  const handleClose = () => {
    if (submitting) return;
    setJsonText("");
    setParseError("");
    setResult(null);
    setFileCountInfo(null);
    setIsDragging(false);
    onClose();
  };

  const processFiles = async (files) => {
    if (!files || files.length === 0) return;
    setParseError("");
    const jsonFiles = Array.from(files).filter(
      (file) => file.name.endsWith(".json") || file.type === "application/json" || file.type === "",
    );

    if (jsonFiles.length === 0) {
      setParseError(translate("Please select valid .json files"));
      return;
    }

    try {
      const allAccounts = [];
      for (const file of jsonFiles) {
        const text = await file.text();
        const accountsFromFile = parseAccountsInput(text);
        if (Array.isArray(accountsFromFile)) {
          allAccounts.push(...accountsFromFile);
        } else if (accountsFromFile) {
          allAccounts.push(accountsFromFile);
        }
      }

      if (allAccounts.length === 0) {
        setParseError(translate("No accounts found in selected files"));
        return;
      }

      setJsonText(JSON.stringify(allAccounts, null, 2));
      setFileCountInfo({
        filesCount: jsonFiles.length,
        accountsCount: allAccounts.length,
      });
    } catch (err) {
      setParseError(`${translate("Error reading files")}: ${err.message}`);
    }
  };

  const handleFileInputChange = (e) => {
    processFiles(e.target.files);
    if (e.target) e.target.value = "";
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer?.files?.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  const handleSubmit = async () => {
    setParseError("");
    setResult(null);

    let accounts;
    try {
      accounts = parseAccountsInput(jsonText);
    } catch (err) {
      setParseError(`${translate("Invalid JSON")}: ${err.message}`);
      return;
    }

    if (!accounts || accounts.length === 0) {
      setParseError(translate("No accounts found in input"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(withOAuthWorkspace("/api/oauth/grok-cli/bulk-import", workspaceId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts }),
      });
      const data = await res.json();

      if (!res.ok) {
        setParseError(data?.error || `Request failed: ${res.status}`);
        return;
      }

      setResult(data);
      if (data.success > 0 && typeof onSuccess === "function") {
        onSuccess();
      }
    } catch (err) {
      setParseError(err.message || translate("Request failed"));
    } finally {
      setSubmitting(false);
    }
  };

  const failedItems = result?.results?.filter((r) => !r.ok) || [];

  return (
    <Modal isOpen={isOpen} title={translate("Bulk add Grok CLI accounts")} onClose={handleClose}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">
            {translate("Upload multiple .json files or paste JSON array / object.")}
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon="upload_file"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
          >
            {translate("Upload JSON files")}
          </Button>
        </div>

        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative rounded border transition-colors ${
            isDragging
              ? "border-coral bg-coral-bg ring-2 ring-coral/30"
              : "border-coral/30 bg-panel"
          }`}
        >
          <textarea
            className="w-full rounded bg-transparent p-2.5 text-sm font-mono resize-y min-h-[240px] focus:outline-none focus:ring-1 focus:ring-coral"
            placeholder={PLACEHOLDER}
            value={jsonText}
            onChange={(e) => {
              setJsonText(e.target.value);
              setFileCountInfo(null);
            }}
            disabled={submitting}
          />

          {isDragging && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-panel/90 rounded pointer-events-none backdrop-blur-xs">
              <span className="material-symbols-outlined text-3xl text-coral-ink mb-1">
                upload_file
              </span>
              <span className="text-sm font-medium text-coral-ink">
                {translate("Drop .json files here")}
              </span>
            </div>
          )}
        </div>

        {fileCountInfo && (
          <Callout variant="ok" className="p-2 text-xs">
            {translate("Loaded")} {fileCountInfo.accountsCount} {translate("account(s) from")}{" "}
            {fileCountInfo.filesCount} {translate("file(s)")}
          </Callout>
        )}

        {parseError && (
          <Callout variant="err" className="break-words">
            {parseError}
          </Callout>
        )}

        {result && result.failed > 0 && (
          <div className="flex flex-col gap-2">
            <StatusPill variant="warn" className="self-start">
              {result.failed} {translate("failed")}
            </StatusPill>
            {failedItems.length > 0 && (
              <ul className="rounded border border-coral/20 bg-raised p-2 text-xs font-mono max-h-40 overflow-y-auto">
                {failedItems.map((item) => (
                  <li key={item.index} className="text-err">
                    [{item.index}] {item.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={submitting || !jsonText.trim()}>
            {submitting ? translate("Importing...") : translate("Import all")}
          </Button>
          <Button onClick={handleClose} variant="ghost" fullWidth disabled={submitting}>
            {translate("Close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
