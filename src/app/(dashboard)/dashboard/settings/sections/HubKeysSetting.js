"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import CopyField from "@/shared/components/CopyField";
import Input from "@/shared/components/Input";
import SettingRow from "@/shared/components/SettingRow";
import { ConfirmDialog } from "@/shared/components/Modal";

async function call(url, method, body) {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const formatDate = (iso) => (iso ? new Date(iso).toLocaleString() : "Never");

/**
 * Usage hub keys (YAN-2019): read-only management keys for T3 Code's
 * "Add hub". Shown only while the hub is on (TOKENHOP_USAGE_HUB=on): the list
 * API answers 404 otherwise and this row renders nothing. The raw key is shown
 * once, right after creation.
 */
export default function HubKeysSetting() {
  const [keys, setKeys] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await call("/api/hub-keys", "GET");
      setKeys(data.keys || []);
      setError("");
    } catch (err) {
      if (err.status === 404 || err.status === 401 || err.status === 403) setHidden(true);
      else setError(err.message || "Could not load hub keys.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (hidden) return null;

  const create = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const data = await call("/api/hub-keys", "POST", { name: name.trim() || null });
      setCreated(data.key);
      setName("");
      await load();
    } catch (err) {
      setError(err.message || "Could not create the hub key.");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async () => {
    await call(`/api/hub-keys/${encodeURIComponent(revokeTarget.id)}`, "DELETE");
    setRevokeTarget(null);
    await load();
  };

  return (
    <div className="py-4">
      <SettingRow
        label="Usage hub keys"
        description="Read-only keys for a usage hub client such as T3. They read quota snapshots only: no /v1 calls, no settings."
      />
      {created && (
        <Callout variant="ok" title="Copy this key now. It won't be shown again.">
          <CopyField value={created} label="Copy hub key" />
        </Callout>
      )}
      {error && <Callout variant="err" title={error} />}
      <form onSubmit={create} className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-52 flex-1">
          <Input
            label="Key name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            placeholder="My laptop"
            disabled={creating}
          />
        </div>
        <Button type="submit" loading={creating} disabled={creating}>
          Create hub key
        </Button>
      </form>
      <ul className="mt-3 divide-y divide-border" aria-label="Usage hub keys">
        {keys?.length === 0 && <li className="py-2 text-sm text-muted">No hub keys yet.</li>}
        {keys?.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text">{k.name || "Unnamed key"}</p>
              <p className="font-mono text-xs text-muted">
                {k.prefix} · Last used: {formatDate(k.lastUsedAt)}
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setRevokeTarget(k)}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        isOpen={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={revoke}
        title="Revoke hub key?"
        message="Clients using this key lose access right away."
        confirmText="Revoke"
      />
    </div>
  );
}
