"use client";

import { useState } from "react";
import { parseKeyBudget } from "../keyBudget";
import { createBudget } from "@/shared/utils/createBudget";

/**
 * Optional per-key budget state for the hashed key-create flow (YAN-376).
 * Owns the USD-limit/window inputs, the partial-failure record, and every
 * budget POST (initial + retry). A failed budget POST never hides the
 * just-created key: the failure is recorded for an explicit retry instead.
 *
 * Failure shape: { keyId, budget, workspaceId, detail, retrying }. The
 * workspaceId is captured at failure time so a retry re-posts against the
 * workspace the key was created in, never the live context if it changed.
 * Retries only ever re-POST the budget row for the already-created key id —
 * they never re-create the key.
 */
export function useKeyBudget(context) {
  const [createBudgetUsd, setCreateBudgetUsd] = useState("");
  const [createBudgetWindow, setCreateBudgetWindow] = useState("month");
  const [budgetFailure, setBudgetFailure] = useState(null);

  /** Clear the inputs and any failure (modal close / fresh create). */
  const resetBudgetForm = () => {
    setCreateBudgetUsd("");
    setCreateBudgetWindow("month");
    setBudgetFailure(null);
  };

  /** Clear a recorded failure (new create attempt / reveal dismissed). */
  const clearBudgetFailure = () => setBudgetFailure(null);

  /** Validate the optional inputs: { budget|null, error|null }. Empty = off. */
  const parseBudgetInput = () => parseKeyBudget(createBudgetUsd, createBudgetWindow);

  const postKeyBudget = (keyId, budget, workspaceId) =>
    createBudget({
      workspaceId: workspaceId ?? context?.workspaceId,
      scopeType: "key",
      scopeId: keyId,
      ...budget,
    });

  /** Record a partial success: key exists, budget row was not saved. */
  const reportBudgetFailure = (keyId, budget, err, workspaceId) =>
    setBudgetFailure({
      keyId,
      budget,
      workspaceId: workspaceId ?? context?.workspaceId,
      detail: err?.message,
      retrying: false,
    });

  /**
   * POST the budget for an already-created key; records failure, never throws.
   * `workspaceId` is the one captured when the key POST was sent.
   */
  const saveBudget = async (keyId, budget, workspaceId) => {
    if (!budget) return;
    try {
      await postKeyBudget(keyId, budget, workspaceId);
    } catch (err) {
      reportBudgetFailure(keyId, budget, err, workspaceId);
    }
  };

  /** Retry only the budget POST for the already-created key. */
  const retryBudget = async () => {
    const f = budgetFailure;
    if (!f || f.retrying) return;
    const same = (cur) => cur?.keyId === f.keyId;
    setBudgetFailure({ ...f, retrying: true });
    try {
      await postKeyBudget(f.keyId, f.budget, f.workspaceId);
      setBudgetFailure((cur) => (same(cur) ? null : cur));
    } catch (err) {
      setBudgetFailure((cur) =>
        same(cur) ? { ...f, retrying: false, detail: err?.message } : cur,
      );
    }
  };

  return {
    createBudgetUsd,
    setCreateBudgetUsd,
    createBudgetWindow,
    setCreateBudgetWindow,
    budgetFailure,
    resetBudgetForm,
    clearBudgetFailure,
    parseBudgetInput,
    postKeyBudget,
    reportBudgetFailure,
    saveBudget,
    retryBudget,
  };
}
