"use client";

// YAN-373: SSO provisioning editor (moved verbatim from page.js). Reads and
// writes the six group-policy keys on GET/PATCH /api/settings, with shared
// workspaces from GET /api/workspaces as mapping targets. No client
// authorization logic: the server omits the policy keys (rendered as
// no-access) or answers 403/404, and the admin layout 404s the whole tree
// when Users & teams is off. The Preview draft card sends the CURRENT FORM
// DRAFT to POST /api/auth/sso/preview, which pairs it with the SAVED protocol
// config; it never previews the saved policy or a synthetic role.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Callout,
  Card,
  Input,
  LoadingState,
  PageTitle,
  Select,
  SettingRow,
  Textarea,
} from "@/shared/components";
import { listWorkspaces } from "@/shared/utils/adminApi";
import { loadSettings } from "@/shared/utils/settingsApi";
import { AdminGuard } from "../components/AdminShared";
import { adminLoadState } from "../adminView";
import { MappingRow } from "./MappingRow";
import { SsoPreviewCard } from "./SsoPreviewCard";
import { ROLE_OPTIONS, nextRowId, toDraft, toPayload, validatePayload } from "./policyDraft";
import { patchSsoPolicy } from "./ssoApi";
import { useSsoPreview } from "./useSsoPreview";

export function ProvisioningForm() {
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState(null); // "hidden"|"denied"|"error"
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedOk, setSavedOk] = useState(false);
  const [tick, setTick] = useState(0);

  const preview = useSsoPreview();

  // CodeRabbit #896: the preview runs against the unsaved draft, which a
  // full-page IdP round trip would otherwise lose. The one-time result carries
  // the exact draft back in memory; restore it and keep `saved` from the
  // server so "dirty" still tells the truth. A late-arriving load() (or the
  // retry effect) must not overwrite the restored draft.
  const restoredDraft = useRef(null);
  const restoredFor = useRef(null);
  useEffect(() => {
    const result = preview.result;
    if (!result?.policy || restoredFor.current === result) return;
    restoredFor.current = result;
    restoredDraft.current = toDraft(result.policy);
    setDraft(restoredDraft.current);
  }, [preview.result]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setLoadState(null);
    setSaveError("");
    try {
      const [settings, wsBody] = await Promise.all([loadSettings(), listWorkspaces()]);
      // GET strips the policy keys for principals without instance.settings.manage
      // (200, not 403): an absent key means this account cannot manage them.
      if (!Object.hasOwn(settings, "ssoDefaultRole")) {
        setLoadState("denied");
        return;
      }
      setWorkspaces(Array.isArray(wsBody.workspaces) ? wsBody.workspaces : []);
      const next = toDraft(settings);
      // Keep the restored preview draft, if any: load() may finish after the
      // result restored it.
      setDraft(restoredDraft.current ?? next);
      setSaved(next);
      setSavedOk(false);
    } catch (err) {
      setLoadState(adminLoadState(err?.status) ?? "error");
      setError(err?.message || "Failed to load provisioning settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the manual retry signal
  useEffect(() => {
    load();
  }, [load, tick]);

  const workspaceOptions = useMemo(
    () =>
      workspaces.map((w) => ({
        value: w.id,
        label: `${w.name} · ${w.memberCount} member${w.memberCount === 1 ? "" : "s"}`,
      })),
    [workspaces],
  );

  const dirty = useMemo(
    () =>
      !!draft && !!saved && JSON.stringify(toPayload(draft)) !== JSON.stringify(toPayload(saved)),
    [draft, saved],
  );

  const patchDraft = (patch) => {
    // Editing after a restore: a later retry must not resurrect it.
    restoredDraft.current = null;
    setSaveError("");
    setSavedOk(false);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const updateRow = (id, patch) =>
    patchDraft({ map: draft.map.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  const addRow = () =>
    patchDraft({
      map: [...draft.map, { id: `row-${nextRowId()}`, group: "", workspaceId: "", role: "member" }],
    });

  const removeRow = (id) => patchDraft({ map: draft.map.filter((r) => r.id !== id) });

  const save = async () => {
    const payload = toPayload(draft);
    const problem = validatePayload(payload);
    if (problem) {
      setSaveError(problem);
      return;
    }
    setSaving(true);
    setSaveError("");
    setSavedOk(false);
    try {
      const body = await patchSsoPolicy(payload);
      const next = toDraft(body);
      restoredDraft.current = null;
      setDraft(next);
      setSaved(next);
      setSavedOk(true);
    } catch (err) {
      if (err?.status === 403) setLoadState("denied");
      else setSaveError(err?.message || "Failed to save provisioning settings.");
    } finally {
      setSaving(false);
    }
  };

  const startPreview = () => {
    const problem = validatePayload(toPayload(draft));
    if (problem) {
      setSaveError(problem);
      return;
    }
    preview.start(toPayload(draft));
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-2">
        <PageTitle>SSO provisioning</PageTitle>
        <p className="max-w-2xl text-sm text-muted">
          Control how sign-ins through SSO become accounts: which groups may sign in, who becomes an
          admin, and which shared workspaces members land in.
        </p>
      </div>

      <AdminGuard loadState={loadState} error={error} onRetry={() => setTick((t) => t + 1)}>
        {loading || !draft ? (
          <LoadingState label="Loading provisioning settings" lines={6} />
        ) : (
          <>
            <Card
              title="Sign-in policy"
              subtitle="Where groups come from and what a new account starts as."
            >
              <div className="flex flex-col divide-y divide-line">
                <SettingRow
                  label="OIDC groups claim"
                  description="Claim path in the OIDC token that lists the user's groups. Nested claims use dots, up to 5 levels."
                  settingKey="ssoGroupsClaim"
                  control={
                    <Input
                      aria-label="OIDC groups claim"
                      placeholder="groups"
                      value={draft.groupsClaim}
                      onChange={(e) => patchDraft({ groupsClaim: e.target.value })}
                      className="w-full sm:w-64"
                    />
                  }
                />
                <SettingRow
                  label="SAML groups attribute"
                  description="Name of the SAML attribute that carries the user's groups."
                  settingKey="samlAttributeGroups"
                  control={
                    <Input
                      aria-label="SAML groups attribute"
                      placeholder="groups"
                      value={draft.samlGroupsAttribute}
                      onChange={(e) => patchDraft({ samlGroupsAttribute: e.target.value })}
                      className="w-full sm:w-64"
                    />
                  }
                />
                <SettingRow
                  label="Default role"
                  description="Role for accounts whose groups match no admin group. Pending approval waits for an admin."
                  settingKey="ssoDefaultRole"
                  control={
                    <Select
                      aria-label="Default role"
                      placeholder={null}
                      options={ROLE_OPTIONS}
                      value={draft.defaultRole}
                      onChange={(e) => patchDraft({ defaultRole: e.target.value })}
                      className="w-full sm:w-64"
                    />
                  }
                />
              </div>
              <Callout variant="info" className="mt-4" title="Groups not in the ID token?">
                <p>
                  tokenhop reads groups from the ID token first and falls back to the userinfo
                  endpoint when the claim is missing. With authentik, enable{" "}
                  <code>Include claims in id_token</code> on the provider scope so group names reach
                  the ID token; otherwise keep the userinfo endpoint available.
                </p>
              </Callout>
            </Card>

            <Card title="Group access" subtitle="One group name per line.">
              <div className="flex flex-col gap-4 md:flex-row">
                <Textarea
                  label="Allowed groups"
                  hint="Empty means every authenticated group may sign in."
                  placeholder={"devs\nops"}
                  rows={5}
                  value={draft.allowedGroupsText}
                  onChange={(e) => patchDraft({ allowedGroupsText: e.target.value })}
                  className="md:flex-1"
                />
                <Textarea
                  label="Admin groups"
                  hint="Members of these groups become instance admins."
                  placeholder={"platform-admins"}
                  rows={5}
                  value={draft.adminGroupsText}
                  onChange={(e) => patchDraft({ adminGroupsText: e.target.value })}
                  className="md:flex-1"
                />
              </div>
            </Card>

            <Card
              title="Workspace mapping"
              subtitle="Place the members of a group into a shared workspace with a role."
              action={
                <Button
                  variant="outline"
                  icon="add"
                  onClick={addRow}
                  disabled={workspaceOptions.length === 0}
                >
                  Add mapping
                </Button>
              }
            >
              {workspaceOptions.length === 0 ? (
                <Callout variant="warn" title="No shared workspaces yet">
                  Only shared workspaces can be mapping targets. Create one first, then add mappings
                  here.
                </Callout>
              ) : draft.map.length === 0 ? (
                <p className="text-sm text-muted">
                  No mappings yet. With an empty map, sign-ins only assign the default role and no
                  workspace membership.
                </p>
              ) : (
                <ul className="flex flex-col gap-3" aria-label="Group to workspace mappings">
                  {draft.map.map((row) => (
                    <MappingRow
                      key={row.id}
                      row={row}
                      workspaces={workspaceOptions}
                      disabled={saving}
                      onChange={updateRow}
                      onRemove={removeRow}
                    />
                  ))}
                </ul>
              )}
            </Card>

            <SsoPreviewCard
              preview={preview}
              onPreview={startPreview}
              disabled={loading || saving}
            />

            <div className="flex flex-col gap-3">
              {saveError ? <Callout variant="err">{saveError}</Callout> : null}
              {savedOk && !dirty ? (
                <Callout variant="ok">Provisioning policy saved.</Callout>
              ) : null}
              <div className="flex justify-end">
                <Button icon="save" loading={saving} disabled={!dirty || saving} onClick={save}>
                  Save provisioning policy
                </Button>
              </div>
            </div>
          </>
        )}
      </AdminGuard>
    </div>
  );
}
