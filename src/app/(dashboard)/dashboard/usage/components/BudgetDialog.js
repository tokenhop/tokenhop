"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Button, Callout, Input, Modal, Select } from "@/shared/components";

// Budget create/edit dialog (YAN-376). Create POSTs /api/workspaces/:id/budgets
// with {scopeType, scopeId, window, limits…}; edit PATCHes /:budgetId with
// limits + softLimitPct only — scope and window are immutable (repo contract),
// so those fields render disabled. Validation mirrors budgetsRepo: at least
// one limit, nonnegative numbers, tokens/requests/soft% integers (soft 1–100).
// Server errors render inline; the dialog never closes optimistically.

const SCOPE_TYPES = ["workspace", "key", "membership", "grant"];
const WINDOWS = ["day", "week", "month", "total"];
const WINDOW_LABELS = { day: "Daily", week: "Weekly", month: "Monthly", total: "Total" };

const emptyText = (value) => (value === "" || value == null ? null : value);
const numberError = (text, { integer = false } = {}) => {
  if (text === "" || text == null) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return "Must be 0 or more";
  if (integer && !Number.isInteger(value)) return "Whole numbers only";
  return null;
};

/**
 * Validate the form. Returns {errors, payload} — payload is null while any
 * error (including "a limit is required") is set.
 */
function validate(form, editing) {
  const errors = {};
  if (!editing) {
    if (form.scopeType === "workspace") form = { ...form, scopeId: "workspace" };
    else if (!form.scopeId.trim()) errors.scopeId = "Required";
  }
  const limits = {
    limitUsd: emptyText(form.limitUsd),
    limitTokens: emptyText(form.limitTokens),
    limitRequests: emptyText(form.limitRequests),
  };
  for (const [field, text] of Object.entries(limits)) {
    const message = numberError(text, { integer: field !== "limitUsd" });
    if (message) errors[field] = message;
    else if (text !== null) limits[field] = Number(text);
  }
  const soft = emptyText(form.softLimitPct);
  if (soft !== null) {
    const message =
      numberError(soft, { integer: true }) ||
      (Number(soft) < 1 || Number(soft) > 100 ? "1 to 100" : null);
    if (message) errors.softLimitPct = message;
    else limits.softLimitPct = Number(soft);
  } else limits.softLimitPct = null;
  if (!errors.limitUsd && !errors.limitTokens && !errors.limitRequests) {
    if (limits.limitUsd == null && limits.limitTokens == null && limits.limitRequests == null)
      errors.limitUsd = "Set at least one limit";
  }
  return { errors, payload: Object.keys(errors).length ? null : limits };
}

export default function BudgetDialog({
  isOpen,
  onClose,
  workspaceId,
  userId = null,
  budget,
  onSaved,
}) {
  const editing = Boolean(budget);
  const [form, setForm] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setFieldErrors({});
    setServerError("");
    setForm({
      scopeType: userId ? "user" : (budget?.scopeType ?? "workspace"),
      scopeId: budget?.scopeType === "workspace" ? "" : (budget?.scopeId ?? ""),
      window: budget?.window ?? "month",
      limitUsd: budget?.limitUsd ?? "",
      limitTokens: budget?.limitTokens ?? "",
      limitRequests: budget?.limitRequests ?? "",
      softLimitPct: budget?.softLimitPct ?? "",
    });
  }, [isOpen, budget, userId]);

  const set = (name) => (event) =>
    setForm((current) => ({
      ...current,
      [name]: event?.target?.value ?? event,
      // A scope switch invalidates any previously picked scopeId.
      ...(name === "scopeType" ? { scopeId: "" } : {}),
    }));

  // Create mode only: scopeId for key/membership is a picklist, never typed.
  // Always workspace-scoped URLs; stale fetches abort on change/close.
  useEffect(() => {
    if (!isOpen || editing) return;
    if (!["key", "membership", "grant"].includes(form?.scopeType)) return;
    const controller = new AbortController();
    setOptionsError("");
    setOptions([]);
    setLoadingOptions(true);
    const get = async (url) => {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res.json();
    };
    const ws = encodeURIComponent(workspaceId);
    const load = async () => {
      if (form.scopeType === "key") {
        const data = await get(`/api/keys?workspaceId=${ws}`);
        return (data.keys ?? []).map((k) => ({ value: k.id, label: k.name || k.prefix || k.id }));
      }
      if (form.scopeType === "membership") {
        const data = await get(`/api/workspaces/${ws}/members`);
        return (data.members ?? []).map((m) => ({
          value: `${workspaceId}:${m.userId}`,
          label: m.displayName || m.userId,
        }));
      }
      const data = await get(`/api/providers?workspaceId=${ws}`);
      const lists = await Promise.all(
        (data.connections ?? []).map(async (c) => {
          const grants = await get(`/api/providers/${encodeURIComponent(c.id)}/grants`);
          return (grants.grants ?? [])
            .filter((g) => !g.revokedAt)
            .map((g) => ({
              value: g.id,
              label: `${c.name || c.provider} — ${g.workspaceId || g.userId}`,
            }));
        }),
      );
      return lists.flat();
    };
    load()
      .then((items) => {
        if (!controller.signal.aborted) setOptions(items);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setOptions([]);
        setOptionsError("Couldn't load the list — switch scope and back to retry");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingOptions(false);
      });
    return () => controller.abort();
  }, [isOpen, editing, form?.scopeType, workspaceId]);

  const canSubmit = useMemo(() => form && validate(form, editing).payload, [form, editing]);

  if (!form) return null;

  const handleSubmit = async () => {
    if (saving) return;
    const { errors, payload } = validate(form, editing);
    setFieldErrors(errors);
    if (!payload) return;
    setServerError("");
    setSaving(true);
    try {
      const base = userId
        ? `/api/users/${encodeURIComponent(userId)}/budgets`
        : `/api/workspaces/${encodeURIComponent(workspaceId)}/budgets`;
      const url = editing ? `${base}/${encodeURIComponent(budget.id)}` : base;
      const body = editing
        ? payload
        : {
            ...(userId
              ? {}
              : {
                  scopeType: form.scopeType,
                  scopeId: form.scopeType === "workspace" ? workspaceId : form.scopeId.trim(),
                }),
            window: form.window,
            ...payload,
          };
      const response = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setServerError(data?.error || `Request failed (${response.status})`);
        return;
      }
      onSaved?.();
      onClose?.();
    } catch {
      setServerError("Network error — try again");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      title={editing ? "Edit budget" : "New budget"}
      description="Cap cost, tokens or requests per UTC day, week or month, or in total. Spend above a soft limit only warns."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={saving}
            disabled={saving || !canSubmit}
          >
            {editing ? "Save changes" : "Create budget"}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Select
          label="Scope"
          value={form.scopeType}
          onChange={set("scopeType")}
          disabled={editing || Boolean(userId)}
          hint={editing ? "Scope can't change after creation" : undefined}
          options={(userId ? ["user"] : SCOPE_TYPES).map((value) => ({ value, label: value }))}
        />
        {!editing && form.scopeType !== "workspace" && (
          <>
            <Select
              label={
                form.scopeType === "key"
                  ? "Key"
                  : form.scopeType === "grant"
                    ? "Connection grant"
                    : "Member"
              }
              value={form.scopeId}
              onChange={set("scopeId")}
              error={fieldErrors.scopeId}
              disabled={loadingOptions}
              hint={
                loadingOptions
                  ? "Loading…"
                  : optionsError || (options.length === 0 ? "Nothing to select yet" : undefined)
              }
              options={options}
            />
            {optionsError && (
              <Callout variant="err" title="Couldn't load the list">
                {optionsError}
              </Callout>
            )}
          </>
        )}
        <Select
          label="Window"
          value={form.window}
          onChange={set("window")}
          disabled={editing}
          hint={editing ? "Window can't change after creation" : undefined}
          options={WINDOWS.map((value) => ({ value, label: WINDOW_LABELS[value] }))}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            label="Cost limit (USD)"
            type="number"
            min="0"
            step="0.01"
            value={form.limitUsd}
            onChange={set("limitUsd")}
            error={fieldErrors.limitUsd}
            placeholder="—"
          />
          <Input
            label="Token limit"
            type="number"
            min="0"
            step="1"
            value={form.limitTokens}
            onChange={set("limitTokens")}
            error={fieldErrors.limitTokens}
            placeholder="—"
          />
          <Input
            label="Request limit"
            type="number"
            min="0"
            step="1"
            value={form.limitRequests}
            onChange={set("limitRequests")}
            error={fieldErrors.limitRequests}
            placeholder="—"
          />
        </div>
        <Input
          label="Soft limit (%)"
          type="number"
          min="1"
          max="100"
          step="1"
          value={form.softLimitPct}
          onChange={set("softLimitPct")}
          error={fieldErrors.softLimitPct}
          hint="Optional warn threshold, 1–100"
        />
        {serverError && (
          <Callout variant="err" title="Couldn't save the budget">
            {serverError}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

BudgetDialog.propTypes = {
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
  workspaceId: PropTypes.string.isRequired,
  userId: PropTypes.string,
  budget: PropTypes.object,
  onSaved: PropTypes.func,
};
