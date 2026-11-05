"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import {
  Button,
  Callout,
  Card,
  CopyField,
  ErrorState,
  IconButton,
  Input,
  LoadingState,
  Toggle,
} from "@/shared/components";
import { ConfirmDialog } from "@/shared/components/Modal";
import { ACTIVE, header } from "@/shared/brand";

// Budget webhook card (YAN-1831) over GET|PUT|DELETE
// /api/workspaces/:id/budget-webhook. One optional URL per workspace, POSTed
// on a soft-limit crossing and on a budget's first rejection, once per window.
// The signing secret is returned only by the create and rotate responses: it
// lives in `revealed` state alone (never storage, URL or console) and is
// cleared on dismiss, rotate, remove, workspace change and unmount. Server
// errors render inline from the response's fixed `error` text; nothing closes
// optimistically. Switch off (YAN-1829): `workspaceId` is the "default" alias.

const SIGNATURE_HEADER = header("signature");
const DOCS_URL = ACTIVE.docsUrl ? `${ACTIVE.docsUrl}/en/users/concepts#budget-webhook` : null;

async function errorText(response) {
  const data = await response.json().catch(() => null);
  return data?.error || `Request failed (${response.status})`;
}

function SecretBanner({ secret, onDismiss }) {
  return (
    <div role="alert" className="flex gap-3 rounded-xl border border-lime/40 bg-lime-bg p-4">
      <span
        className="material-symbols-outlined shrink-0 text-[20px] text-lime-ink"
        aria-hidden="true"
      >
        vpn_key
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm font-semibold text-text">
          Signing secret ready. Copy it now, it won&apos;t be shown again.
        </p>
        <CopyField value={secret} label="Copy signing secret" />
      </div>
      <IconButton icon="close" aria-label="Dismiss" onClick={onDismiss} className="self-start" />
    </div>
  );
}

SecretBanner.propTypes = {
  secret: PropTypes.string.isRequired,
  onDismiss: PropTypes.func.isRequired,
};

export default function BudgetWebhookCard({ workspaceId, canManage = false }) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((value) => value + 1), []);
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [revealed, setRevealed] = useState(null);
  const [confirm, setConfirm] = useState(null); // null | "rotate" | "remove"

  const endpoint = workspaceId
    ? `/api/workspaces/${encodeURIComponent(workspaceId)}/budget-webhook`
    : null;

  const applyWebhook = useCallback((webhook) => {
    setState((s) => ({ ...s, data: { ...s.data, webhook } }));
    setUrl(webhook?.url ?? "");
    setEnabled(webhook ? webhook.enabled : true);
  }, []);

  // A workspace change drops any secret still on screen before loading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-fetches after a retry
  useEffect(() => {
    setRevealed(null);
    setSaveError("");
    if (!canManage || !endpoint) return undefined;
    const controller = new AbortController();
    setState({ data: null, error: null, loading: true });
    fetch(endpoint, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`budget webhook ${r.status}`))))
      .then((data) => {
        if (controller.signal.aborted) return;
        const webhook = data?.webhook ?? null;
        setState({
          data: { webhook, allowPrivateNetworks: data?.allowPrivateNetworks === true },
          error: null,
          loading: false,
        });
        setUrl(webhook?.url ?? "");
        setEnabled(webhook ? webhook.enabled : true);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ data: null, error, loading: false });
      });
    return () => controller.abort();
  }, [canManage, endpoint, reload]);

  if (!canManage || !workspaceId) return null;

  const webhook = state.data?.webhook ?? null;
  const trimmedUrl = url.trim();
  const changes = {};
  if (!webhook || trimmedUrl !== webhook.url) changes.url = trimmedUrl;
  if (!webhook || enabled !== webhook.enabled) changes.enabled = enabled;
  const canSave = !saving && trimmedUrl !== "" && Object.keys(changes).length > 0;

  const save = async () => {
    if (!canSave) return;
    setSaveError("");
    setSaving(true);
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!response.ok) {
        setSaveError(await errorText(response));
        return;
      }
      const data = await response.json();
      applyWebhook(data.webhook ?? null);
      if (typeof data.secret === "string") setRevealed(data.secret);
    } catch {
      setSaveError("Network error — try again");
    } finally {
      setSaving(false);
    }
  };

  // ConfirmDialog shows a thrown Error's message and stays open.
  const rotate = async () => {
    setRevealed(null);
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotateSecret: true }),
    }).catch(() => null);
    if (!response) throw new Error("Network error — try again");
    if (!response.ok) throw new Error(await errorText(response));
    const data = await response.json();
    applyWebhook(data.webhook ?? null);
    if (typeof data.secret === "string") setRevealed(data.secret);
    setConfirm(null);
  };

  const remove = async () => {
    setRevealed(null);
    const response = await fetch(endpoint, { method: "DELETE" }).catch(() => null);
    if (!response) throw new Error("Network error — try again");
    if (!response.ok && response.status !== 404) throw new Error(await errorText(response));
    applyWebhook(null);
    setSaveError("");
    setConfirm(null);
  };

  return (
    <Card
      title="Budget webhook"
      subtitle="POST a signed JSON notice to your endpoint when a budget crosses its soft limit or first rejects a request, once per window."
    >
      {state.loading ? (
        <LoadingState label="Loading budget webhook" />
      ) : state.error ? (
        <ErrorState
          title="Couldn't load the budget webhook"
          message={state.error.message || "Try reloading the page."}
          onRetry={retry}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          {revealed && <SecretBanner secret={revealed} onDismiss={() => setRevealed(null)} />}
          <Input
            label="Webhook URL"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://hooks.example.com/budgets"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={saving}
            error={saveError || undefined}
            maxLength={2000}
            dir="ltr"
          />
          <Toggle
            checked={enabled}
            onChange={(next) => setEnabled(next)}
            disabled={saving}
            label="Webhook enabled"
            description="When off, notices still appear in the dashboard but nothing is sent."
          />
          {webhook?.secretSet && (
            <p className="text-sm text-muted">
              Signing secret: <span className="font-semibold text-text">set</span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={save} loading={saving} disabled={!canSave}>
              {webhook ? "Save changes" : "Add webhook"}
            </Button>
            {webhook && (
              <>
                <Button
                  variant="secondary"
                  icon="autorenew"
                  onClick={() => setConfirm("rotate")}
                  disabled={saving}
                >
                  Rotate secret
                </Button>
                <Button
                  variant="ghost"
                  icon="delete"
                  onClick={() => setConfirm("remove")}
                  disabled={saving}
                >
                  Remove
                </Button>
              </>
            )}
          </div>
          <Callout variant="info" title="Allowed destinations">
            <p>
              Only https destinations on the public internet are allowed. Link-local and cloud
              metadata addresses are always blocked, and redirects are never followed.
              {state.data?.allowPrivateNetworks
                ? " This instance also allows private networks and http."
                : ""}
            </p>
            <p className="mt-1">
              Verify each request with the <code className="font-mono">{SIGNATURE_HEADER}</code>{" "}
              header.
              {DOCS_URL && (
                <>
                  {" "}
                  <a
                    href={DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-coral hover:underline"
                  >
                    How to verify
                  </a>
                </>
              )}
            </p>
          </Callout>
        </div>
      )}
      <ConfirmDialog
        isOpen={confirm === "rotate"}
        onClose={() => setConfirm(null)}
        onConfirm={rotate}
        title="Rotate signing secret?"
        message="The current secret stops working at once. Update your endpoint with the new secret."
        confirmText="Rotate secret"
        variant="danger"
      />
      <ConfirmDialog
        isOpen={confirm === "remove"}
        onClose={() => setConfirm(null)}
        onConfirm={remove}
        title="Remove budget webhook?"
        message="Budget notices will no longer be sent to this URL. The signing secret is deleted."
        confirmText="Remove"
        variant="danger"
      />
    </Card>
  );
}

BudgetWebhookCard.propTypes = {
  /** Workspace id, or "default" while Users & teams is off. */
  workspaceId: PropTypes.string,
  /** Caller already checked the live budget-manage capability; the server re-checks. */
  canManage: PropTypes.bool,
};
