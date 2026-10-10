import { NextResponse } from "next/server";
import {
  getProviderConnectionByIdUnscoped,
  getProxyPoolById,
  updateProviderConnectionUnscoped,
  deleteProviderConnectionUnscoped,
} from "@/models";
import { deleteConnection, getConnection, updateConnection } from "@/lib/db/index.js";
import { loadScoped, redactConnection } from "@/lib/users/workspaceScope.js";
import { mutateBillingLockUnscoped } from "@/lib/db/repos/connectionsRepo.js";
import { getBillingLock } from "open-sse/services/accountFallback.js";
import { getAdapter } from "@/lib/db/driver.js";
import { readCredentialEncryptionState } from "@/lib/db/credentialEncryptionState.js";
import { PLAN_CAPACITY } from "open-sse/config/quotaSnapshot.js";
import { sanitizePlanTier, clearSnapshotPlanTier } from "open-sse/services/quotaSnapshot.js";

const DANGEROUS_MAP_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function validateWeightedOverrides(psd, provider) {
  for (const key of ["weight", "planTier", "planTierManual"]) {
    if (!Object.hasOwn(psd, key)) continue;
    const value = psd[key];
    switch (key) {
      case "weight":
        if (value === null) break;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000) {
          return {
            error: "providerSpecificData.weight must be a finite number between 0 and 1000",
          };
        }
        break;
      case "planTier": {
        if (value === null) break;
        const tier = sanitizePlanTier(value);
        const capacity = PLAN_CAPACITY[provider];
        if (!tier || !capacity || !Object.hasOwn(capacity, tier)) {
          return {
            error: `providerSpecificData.planTier must be a known plan tier for ${provider}`,
          };
        }
        break;
      }
      case "planTierManual":
        if (value === null) break;
        if (typeof value !== "boolean") {
          return { error: "providerSpecificData.planTierManual must be a boolean" };
        }
        break;
    }
  }
  return {};
}

// Apply validated weighted overrides: null clears, planTier stored sanitized.
function applyWeightedOverrides(target, psd) {
  for (const key of ["weight", "planTier", "planTierManual"]) {
    if (!Object.hasOwn(psd, key)) continue;
    const value = psd[key];
    // YAN-365: null stays in the delta patch; the repo deletes the live key.
    if (value === null) target[key] = null;
    else target[key] = key === "planTier" ? sanitizePlanTier(value) : value;
  }
}

function hasDangerousKeys(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, inner] of Object.entries(value)) {
    if (DANGEROUS_MAP_KEYS.has(key)) return true;
    if (typeof inner === "object" && inner !== null && hasDangerousKeys(inner)) return true;
  }
  return false;
}

function normalizeProxyConfig(body = {}) {
  const hasAnyProxyField =
    Object.hasOwn(body, "connectionProxyEnabled") ||
    Object.hasOwn(body, "connectionProxyUrl") ||
    Object.hasOwn(body, "connectionNoProxy");

  if (!hasAnyProxyField) return { hasAnyProxyField: false };

  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return {
      hasAnyProxyField: true,
      error: "Connection proxy URL is required when connection proxy is enabled",
    };
  }

  return {
    hasAnyProxyField: true,
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolUpdate(proxyPoolIdInput) {
  if (proxyPoolIdInput === undefined) {
    return { hasProxyPoolField: false, proxyPoolId: null };
  }

  if (proxyPoolIdInput === null || proxyPoolIdInput === "" || proxyPoolIdInput === "__none__") {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPoolId = String(proxyPoolIdInput).trim();
  if (!proxyPoolId) {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(proxyPoolId);
  if (!proxyPool) {
    return { hasProxyPoolField: true, error: "Proxy pool not found" };
  }

  return { hasProxyPoolField: true, proxyPoolId };
}

function shouldMergeProviderSpecificData(existing, incoming, hasLegacyProxy, hasProxyPoolField) {
  return existing !== undefined || incoming !== undefined || hasLegacyProxy || hasProxyPoolField;
}

// YAN-365: once credential encryption is established, responses always strip
// the full D10 allow-list (even with a null scope). Never-encrypted installs
// keep today's switch-off response shape.
async function redactionScope(scope) {
  if (scope) return scope;
  const state = readCredentialEncryptionState(await getAdapter());
  return state.storage === "encrypted" ? {} : null;
}

// YAN-361: switch on, the row must be in one of the principal's workspaces.
const load = (capability, id) =>
  loadScoped(
    capability,
    id,
    getConnection,
    getProviderConnectionByIdUnscoped,
    "Connection not found",
  );

// GET /api/providers/[id] - Get single connection
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const loaded = await load("workspace.connections.metadata.read", id);
    if (loaded instanceof Response) return loaded;
    const connection = loaded.row;

    // Hide sensitive fields
    const result = {
      ...redactConnection(await redactionScope(loaded.scope), connection),
    };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error fetching connection:", error);
    return NextResponse.json({ error: "Failed to fetch connection" }, { status: 500 });
  }
}

// PUT /api/providers/[id] - Update connection
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      priority,
      globalPriority,
      defaultModel,
      isActive,
      apiKey,
      testStatus,
      lastError,
      lastErrorAt,
      providerSpecificData,
    } = body;

    const loaded = await load("workspace.connections.manage", id);
    if (loaded instanceof Response) return loaded;
    const existing = loaded.row;

    if (
      providerSpecificData != null &&
      (typeof providerSpecificData !== "object" || Array.isArray(providerSpecificData))
    ) {
      return NextResponse.json(
        { error: "providerSpecificData must be an object" },
        { status: 400 },
      );
    }
    if (hasDangerousKeys(providerSpecificData)) {
      return NextResponse.json({ error: "Unsafe providerSpecificData key" }, { status: 400 });
    }
    const weightedValidation = validateWeightedOverrides(
      providerSpecificData || {},
      existing.provider,
    );
    if (weightedValidation.error) {
      return NextResponse.json({ error: weightedValidation.error }, { status: 400 });
    }

    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolUpdate(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (priority !== undefined) updateData.priority = priority;
    if (globalPriority !== undefined) updateData.globalPriority = globalPriority;
    if (defaultModel !== undefined) updateData.defaultModel = defaultModel;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (apiKey && (existing.authType === "apikey" || existing.authType === "cookie")) {
      updateData.apiKey = apiKey;
    }
    if (testStatus !== undefined) updateData.testStatus = testStatus;
    if (lastError !== undefined) updateData.lastError = lastError;
    if (lastErrorAt !== undefined) updateData.lastErrorAt = lastErrorAt;

    if (
      shouldMergeProviderSpecificData(
        existing.providerSpecificData,
        providerSpecificData,
        proxyConfig.hasAnyProxyField,
        proxyPoolResult.hasProxyPoolField,
      )
    ) {
      // YAN-365: delta write — send only the keys the client changed. The repo
      // merges them onto the live decrypted row's siblings in one transaction,
      // so a token refresh landing between this load and the write survives.
      updateData.providerSpecificData = {
        ...(providerSpecificData || {}),
      };
      applyWeightedOverrides(updateData.providerSpecificData, providerSpecificData || {});

      if (proxyConfig.hasAnyProxyField) {
        updateData.providerSpecificData.connectionProxyEnabled = proxyConfig.connectionProxyEnabled;
        updateData.providerSpecificData.connectionProxyUrl = proxyConfig.connectionProxyUrl;
        updateData.providerSpecificData.connectionNoProxy = proxyConfig.connectionNoProxy;
      }

      if (proxyPoolResult.hasProxyPoolField) {
        if (proxyPoolResult.proxyPoolId === null) {
          // YAN-365: explicit null clears the live sibling (a deleted key in a
          // delta patch would leave the stored value in place).
          updateData.providerSpecificData.proxyPoolId = null;
        } else {
          updateData.providerSpecificData.proxyPoolId = proxyPoolResult.proxyPoolId;
        }
      }
    }

    // YAN-1041: recovery escapes for a permanent billing lock. A NEW api key or
    // a disabled -> enabled flip means the credit situation may have changed,
    // so clear billing-owned state only (transactional, conditional on the
    // live row: model locks, auth state and everything else are preserved).
    const keyChanged = Boolean(updateData.apiKey) && updateData.apiKey !== existing.apiKey;
    const reEnabled = updateData.isActive === true && existing.isActive === false;
    const clearsBilling = (keyChanged || reEnabled) && Boolean(getBillingLock(existing));

    const updated = loaded.scope
      ? await updateConnection(loaded.scope.ctx, id, updateData)
      : await updateProviderConnectionUnscoped(id, updateData);
    if (clearsBilling) {
      const cleared = await mutateBillingLockUnscoped(id, (live) =>
        getBillingLock(live) ? { billingLock: null } : null,
      );
      if (cleared.applied && updated) updated.billingLock = null;
    }
    const oldManualTier =
      existing.providerSpecificData?.planTierManual === true
        ? sanitizePlanTier(existing.providerSpecificData.planTier)
        : null;
    // Delta patch: derive the next tier view locally (existing + delta, null
    // clears) for the snapshot decision only; nothing here is persisted.
    let nextPsd;
    if (updateData.providerSpecificData) {
      nextPsd = { ...(existing.providerSpecificData || {}), ...updateData.providerSpecificData };
      for (const [key, value] of Object.entries(updateData.providerSpecificData)) {
        if (value === null) delete nextPsd[key];
      }
    }
    const nextManualTier =
      nextPsd?.planTierManual === true ? sanitizePlanTier(nextPsd.planTier) : null;
    if (oldManualTier && nextPsd && oldManualTier !== nextManualTier) {
      clearSnapshotPlanTier(id, oldManualTier);
    }

    // Hide sensitive fields
    const result = { ...redactConnection(await redactionScope(loaded.scope), updated) };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error updating connection:", error);
    return NextResponse.json({ error: "Failed to update connection" }, { status: 500 });
  }
}

// DELETE /api/providers/[id] - Delete connection
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const loaded = await load("workspace.connections.manage", id);
    if (loaded instanceof Response) return loaded;

    const deleted = loaded.scope
      ? await deleteConnection(loaded.scope.ctx, id)
      : await deleteProviderConnectionUnscoped(id);
    if (!deleted) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Connection deleted successfully" });
  } catch (error) {
    console.log("Error deleting connection:", error);
    return NextResponse.json({ error: "Failed to delete connection" }, { status: 500 });
  }
}
