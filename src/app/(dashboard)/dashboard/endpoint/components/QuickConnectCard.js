"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import { useState } from "react";
import { Card, Button, Select, Tabs } from "@/shared/components";
import Input from "@/shared/components/Input";
import {
  buildNeovimMinuetConfig,
  buildZedEditPredictionConfig,
  duplicateKeyLabel,
  quickConnectSnippets,
} from "../endpointLogic";
import CopyStatus from "@/shared/components/CopyStatus";

const LANGUAGES = [
  { value: "shell", label: "Shell" },
  { value: "curl", label: "cURL" },
  { value: "python", label: "Python" },
  { value: "zed", label: "Zed" },
  { value: "neovim", label: "Neovim" },
];

const EXAMPLE_MODEL = "prediction-fast";

/** Snippet panel with its own copy button; `onCopy` is only set when copying is allowed. */
function CodeBlock({ code, copyId, label, onCopy, copiedId, copyError }) {
  const state = copiedId === copyId ? "copied" : copyError === copyId ? "error" : "idle";
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-raised">
      <pre
        dir="ltr"
        className="max-h-64 overflow-auto whitespace-pre p-4 text-start font-mono text-[13px] leading-relaxed text-text"
      >
        <code>{code}</code>
      </pre>
      <div className="flex justify-end border-t border-line px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          icon={state === "copied" ? "check" : state === "error" ? "error" : "content_copy"}
          disabled={!onCopy}
          onClick={() => onCopy?.()}
        >
          {state === "copied" ? "Copied" : state === "error" ? "Couldn't copy" : label}
        </Button>
        <CopyStatus copied={copiedId} error={copyError} id={copyId} />
      </div>
    </div>
  );
}

/**
 * Quick connect card: key picker + Shell/cURL/Python snippet. The screen shows
 * the masked key; copying pastes the real full key (same template, real
 * secret). The full key is also never shown from the eye-reveal state — only
 * the just-created banner or explicit per-row reveal shows it.
 *
 * Hashed storage: rows are prefix-only, so only the just-created key (held in
 * memory via `revealed`) can produce a copyable snippet; other keys render the
 * placeholder mask and disable Copy with a helper line.
 *
 * @param {object} props
 * @param {string} props.baseUrl Endpoint root (e.g. http://localhost:20128/v1).
 * @param {string|null} props.selectedKeyId
 * @param {Array} props.keys Key rows {id,name,key?,prefix?}.
 * @param {{ id: string, plain: string }|null} props.revealed Just-created key plain text.
 * @param {(id: string) => void} props.onSelectKey
 * @param {(text: string, id: string) => void} props.onCopy
 * @param {string|null} props.copiedId
 * @param {boolean} [props.hashedMode] Prefix-only rows; restricts copy to the just-created key.
 */
export default function QuickConnectCard({
  baseUrl,
  selectedKeyId,
  keys,
  revealed,
  onSelectKey,
  onCopy,
  copiedId,
  copyError,
  hashedMode = false,
}) {
  const [language, setLanguage] = useState("shell");
  const [model, setModel] = useState("");
  const selected = keys.find((key) => key.id === selectedKeyId) ?? null;
  const effectiveKey =
    revealed && revealed.id === selectedKeyId ? { key: revealed.plain } : selected;
  const {
    display: snippet,
    copy: copySnippet,
    config,
  } = quickConnectSnippets(language, baseUrl, effectiveKey, model);
  const copyId = `quick-${language}`;
  const canCopy = Boolean(copySnippet);
  const isEditor = language === "zed" || language === "neovim";
  // Show the example ID until the user types one; copy stays off until they do.
  const shownConfig = isEditor
    ? (config ??
      (language === "zed" ? buildZedEditPredictionConfig : buildNeovimMinuetConfig)(
        baseUrl,
        EXAMPLE_MODEL,
      ))
    : null;

  return (
    <Card title="Quick connect" icon="bolt">
      <div className="flex flex-col gap-4">
        <Select
          label="API key"
          value={selectedKeyId ?? ""}
          onChange={(event) => onSelectKey(event.target.value)}
          options={keys.map((key) => ({ value: key.id, label: duplicateKeyLabel(key, keys) }))}
          placeholder={keys.length === 0 ? "No keys yet" : "Select a key"}
          disabled={keys.length === 0}
        />

        <Tabs
          tabs={LANGUAGES}
          value={language}
          onChange={setLanguage}
          aria-label="Quick connect language"
        />

        {isEditor && (
          <>
            <Input
              label="Model or combo ID"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={EXAMPLE_MODEL}
              hint={`Use a model or combo ID from your dashboard. "${EXAMPLE_MODEL}" is only an example.`}
              autoComplete="off"
              spellCheck={false}
            />
            <CodeBlock
              code={shownConfig}
              copyId={`${copyId}-config`}
              label={language === "zed" ? "Copy settings" : "Copy config"}
              onCopy={config ? () => onCopy(config, `${copyId}-config`) : undefined}
              copiedId={copiedId}
              copyError={copyError}
            />
            <p className="text-xs text-muted">
              Then set the API key in the environment your editor starts from:
            </p>
          </>
        )}

        <CodeBlock
          code={snippet}
          copyId={copyId}
          label={isEditor ? "Copy key export" : "Copy snippet"}
          onCopy={canCopy ? () => onCopy(copySnippet, copyId) : undefined}
          copiedId={copiedId}
          copyError={copyError}
        />

        {hashedMode && !canCopy && keys.length > 0 && (
          <p className="text-xs text-muted">
            Create a new key to copy a snippet — full keys aren&apos;t stored.
          </p>
        )}

        <div className="border-t border-line pt-3">
          <Link
            href="/dashboard/cli-tools"
            className="text-sm font-medium text-coral hover:underline"
          >
            Using a coding CLI? Set it up in one click &rarr;
          </Link>
          {isEditor && (
            <a
              href="https://tokenhop.dev/en/integration/edit-predictions/"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 block text-sm font-medium text-coral hover:underline"
            >
              Edit predictions help &rarr;
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}

CodeBlock.propTypes = {
  code: PropTypes.string.isRequired,
  copyId: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  onCopy: PropTypes.func,
  copiedId: PropTypes.string,
  copyError: PropTypes.string,
};

QuickConnectCard.propTypes = {
  baseUrl: PropTypes.string.isRequired,
  selectedKeyId: PropTypes.string,
  keys: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      key: PropTypes.string,
      prefix: PropTypes.string,
    }),
  ).isRequired,
  revealed: PropTypes.shape({
    id: PropTypes.string.isRequired,
    plain: PropTypes.string.isRequired,
  }),
  onSelectKey: PropTypes.func.isRequired,
  onCopy: PropTypes.func.isRequired,
  copiedId: PropTypes.string,
  copyError: PropTypes.string,
  hashedMode: PropTypes.bool,
};
