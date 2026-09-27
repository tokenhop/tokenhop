"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import Modal from "@/shared/components/Modal";
import Toggle from "@/shared/components/Toggle";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { duplicateKeyLabel } from "../endpoint/endpointLogic";
import { maskApiKey } from "./format";
import { WidgetEmpty, WidgetError, WidgetSkeleton } from "./WidgetStates";

/**
 * The 2 most recently created keys, newest first.
 * @param {Array<object>} keys full key records
 * @returns {Array<object>}
 */
export function recentKeys(keys) {
  return [...(keys || [])]
    .sort((a, b) => new Date(b?.createdAt || 0) - new Date(a?.createdAt || 0))
    .slice(0, 2);
}

/**
 * API keys summary: active/paused counts, 2 most recent masked keys with
 * toggles (PUT /api/keys/[id]), and New key (existing create flow: POST /api/keys).
 * Creation returns the secret once, so the modal keeps the one-time reveal banner.
 *
 * @param {object} props
 * @param {Array<object>} props.keys
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 * @param {() => void} props.onChanged bump the parent refresh key after create/toggle
 */
export default function KeysSummary({ keys, loading, error, onRetry, onChanged }) {
  const [toggling, setToggling] = useState(null);
  const [toggleError, setToggleError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [keyName, setKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState(null);
  const { copied, copy } = useCopyToClipboard();

  if (loading) return <WidgetSkeleton lines={2} label="Loading API keys" />;
  if (error) return <WidgetError message={error} onRetry={onRetry} />;
  if (keys.length === 0) {
    return (
      <WidgetEmpty
        icon="key"
        title="No API keys yet"
        body="Create a key so clients can reach your endpoint."
        actionLabel="Endpoint and keys"
        actionHref="/dashboard/endpoint"
      />
    );
  }

  const active = keys.filter((key) => key.isActive !== false).length;
  const paused = keys.length - active;

  const toggle = async (key) => {
    setToggling(key.id);
    setToggleError(null);
    try {
      const response = await fetch(`/api/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !(key.isActive !== false) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Could not update the key");
      onChanged?.();
    } catch (err) {
      setToggleError(err.message || "Could not update the key");
    } finally {
      setToggling(null);
    }
  };

  const create = async () => {
    const name = keyName.trim();
    if (!name) {
      setCreateError("Give the key a name first.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Could not create the key");
      setCreatedKey(payload);
      setKeyName("");
      onChanged?.();
    } catch (err) {
      setCreateError(err.message || "Could not create the key");
    } finally {
      setCreating(false);
    }
  };

  const closeModal = () => {
    setCreating(false);
    setCreateError(null);
    setCreatedKey(null);
    setKeyName("");
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">
          API keys
        </span>
        <Button
          variant="secondary"
          size="sm"
          icon="add"
          onClick={() => setCreating(true)}
          className="ms-auto"
        >
          New key
        </Button>
      </div>

      <p className="flex items-baseline gap-2">
        <span className="font-display text-[44px] leading-none font-bold text-text">{active}</span>
        <span className="text-sm text-muted">active · {paused} paused</span>
      </p>

      <ul className="flex min-w-0 flex-col">
        {recentKeys(keys).map((key) => {
          const enabled = key.isActive !== false;
          return (
            <li key={key.id} className="flex items-center gap-2.5 border-t border-line py-2">
              <span className="truncate text-sm font-semibold text-text">
                {duplicateKeyLabel(key, keys)}
              </span>
              <span className="truncate font-mono text-xs text-muted">{maskApiKey(key.key)}</span>
              <Toggle
                checked={enabled}
                disabled={toggling === key.id}
                onChange={() => toggle(key)}
                aria-label={`${duplicateKeyLabel(key, keys)} key ${enabled ? "enabled" : "paused"}`}
                className="ms-auto"
              />
            </li>
          );
        })}
      </ul>
      {toggleError ? <Callout variant="err">{toggleError}</Callout> : null}

      <Modal
        isOpen={creating}
        onClose={closeModal}
        title={createdKey ? "Key created" : "New API key"}
        footer={
          createdKey ? (
            <Button variant="secondary" onClick={closeModal}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeModal}>
                Cancel
              </Button>
              <Button variant="primary" loading={creating} onClick={create}>
                Create key
              </Button>
            </>
          )
        }
      >
        {createdKey ? (
          <div className="flex flex-col gap-3">
            <Callout variant="warn" title="Copy it now">
              This is the only time the full key is shown. Store it somewhere safe.
            </Callout>
            <code className="block truncate rounded-lg border border-line bg-raised p-3 font-mono text-sm text-text">
              {createdKey.key}
            </code>
            <div>
              <Button
                variant="secondary"
                size="sm"
                icon="content_copy"
                onClick={() => copy(createdKey.key, "new-key")}
              >
                {copied === "new-key" ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Input
              label="Key name"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              placeholder="Laptop"
              maxLength={64}
            />
            {createError ? <Callout variant="err">{createError}</Callout> : null}
          </div>
        )}
      </Modal>
    </div>
  );
}

KeysSummary.propTypes = {
  keys: PropTypes.arrayOf(PropTypes.object),
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
  onChanged: PropTypes.func,
};

/** Card wrapper so the page grid stays dumb. */
export function KeysSummaryCard(props) {
  return (
    <Card className="min-w-0">
      <KeysSummary {...props} />
    </Card>
  );
}
