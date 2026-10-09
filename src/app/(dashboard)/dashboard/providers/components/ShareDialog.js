"use client";

import PropTypes from "prop-types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Callout, Checkbox, Input, Modal, Select } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import {
  buildSharePayload,
  isPersonalConnection,
  memberGranteeOptions,
  shareableWorkspaceOptions,
} from "../sharing";

const TERMS_LINKS = [
  { href: "https://www.anthropic.com/legal/consumer-terms", label: "Anthropic consumer terms" },
  {
    href: "https://code.claude.com/docs/en/legal-and-compliance",
    label: "Claude Code legal and compliance",
  },
  { href: "https://openai.com/policies/terms-of-use/", label: "OpenAI terms of use" },
  {
    href: "https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan",
    label: "Codex subscription terms",
  },
  {
    href: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
    label: "GitHub terms of service",
  },
];

/** Read one JSON body without throwing (empty/HTML error bodies → null). */
const readJson = (res) => res.json().catch(() => null);

/**
 * Share a connection (YAN-376): grant a workspace or a single member access
 * to one connection, optionally narrowed by model list and rpm/tpm. Personal
 * (subscription-bound) connections additionally need the instance
 * allowPersonalConnectionGrants toggle (owner/admin only) and an explicit
 * acknowledgement before the terms echo is ever sent. Payload assembly is
 * {@link buildSharePayload}; the checkbox gates the POST, never an auto-ack.
 */
export default function ShareDialog({
  isOpen,
  onClose,
  connection,
  workspaces,
  userId,
  isInstanceAdmin = false,
  onShared,
}) {
  const notify = useNotificationStore();
  const personal = isPersonalConnection(connection);

  const [granteeType, setGranteeType] = useState("workspace");
  const [workspaceId, setWorkspaceId] = useState("");
  const [granteeUserId, setGranteeUserId] = useState("");
  const [members, setMembers] = useState([]);
  const [membersError, setMembersError] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [rpm, setRpm] = useState("");
  const [tpm, setTpm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [policyAllowed, setPolicyAllowed] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState([]);

  const workspaceOptions = useMemo(() => shareableWorkspaceOptions(workspaces), [workspaces]);

  // Reset the form whenever the dialog (re)opens for a target connection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset must only run when the modal opens or the target connection changes
  useEffect(() => {
    if (!isOpen) return;
    setGranteeType("workspace");
    setWorkspaceId("");
    setGranteeUserId("");
    setMembers([]);
    setMembersError("");
    setModelsText("");
    setRpm("");
    setTpm("");
    setAcknowledged(false);
    setPolicyAllowed(null);
    setSubmitting(false);
    setErrors([]);
  }, [isOpen, connection?.id]);

  // Default the workspace to the first managed shared workspace.
  useEffect(() => {
    if (isOpen && !workspaceId && workspaceOptions.length > 0) {
      setWorkspaceId(workspaceOptions[0].value);
    }
  }, [isOpen, workspaceId, workspaceOptions]);

  // Members of the selected shared workspace, only for a user grantee.
  // Personal workspaces never appear in workspaceOptions, so no call is made.
  const membersKey = isOpen && granteeType === "user" ? workspaceId : null;
  useEffect(() => {
    setMembers([]);
    if (!membersKey) return;
    let cancelled = false;
    setMembersError("");
    fetch(`/api/workspaces/${encodeURIComponent(membersKey)}/members`, { cache: "no-store" })
      .then(async (res) => {
        const data = await readJson(res);
        if (cancelled) return; // ignore late fetches
        if (!res.ok) throw new Error(data?.error || "Could not load members");
        setMembers(Array.isArray(data.members) ? data.members : []);
      })
      .catch((err) => {
        if (!cancelled) {
          setMembers([]);
          setMembersError(err?.message || "Could not load members");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [membersKey]);

  // Policy gate: read the instance toggle once per open, owner/admin only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check when the target connection changes while open
  // Non-admins never fetch it; they simply cannot share personal connections.
  useEffect(() => {
    if (!isOpen || !personal || !isInstanceAdmin) return;
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then(async (res) => {
        const data = await readJson(res);
        if (cancelled) return;
        setPolicyAllowed(res.ok ? data?.allowPersonalConnectionGrants === true : false);
      })
      .catch(() => {
        if (!cancelled) setPolicyAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, personal, isInstanceAdmin, connection?.id]);

  const userOptions = useMemo(
    () => memberGranteeOptions(members, { excludeUserId: userId }),
    [members, userId],
  );

  const toggleGranteeType = useCallback((next) => {
    setGranteeType(next);
    setGranteeUserId("");
    setErrors([]);
  }, []);

  // Personal connections: admin + toggle + acknowledgement, in that order.
  const personalBlock = personal && (!isInstanceAdmin || policyAllowed !== true || !acknowledged);
  const noWorkspace = workspaceOptions.length === 0;
  const submitDisabled =
    submitting || noWorkspace || personalBlock || (granteeType === "user" && !granteeUserId);

  const submit = async () => {
    setErrors([]);
    if (personalBlock) {
      setErrors(["Acknowledge the provider terms before sharing."]);
      return;
    }
    if (submitDisabled) return;
    const { payload, errors: buildErrors } = buildSharePayload({
      granteeType,
      workspaceId: granteeType === "workspace" ? workspaceId : null,
      userId: granteeType === "user" ? granteeUserId : null,
      modelsText,
      rpm,
      tpm,
      connection,
    });
    if (!payload) {
      setErrors(buildErrors);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(connection.id)}/grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJson(res);
      if (!res.ok) {
        const detail = data?.error || "Could not share this connection.";
        setErrors([data?.warning ? `${detail} ${data.warning}` : detail]);
        return;
      }
      notify.success(
        granteeType === "workspace"
          ? "Connection shared with the workspace"
          : "Connection shared with the member",
      );
      onShared?.();
      onClose?.();
    } catch (err) {
      setErrors([err?.message || "Could not share this connection."]);
    } finally {
      setSubmitting(false);
    }
  };

  if (!connection) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Share "${connection.name || connection.provider}"`}
      description="Give a workspace or one of its members access through this connection."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={submitting} disabled={submitDisabled}>
            Share
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!submitDisabled) submit();
        }}
      >
        {noWorkspace ? (
          <Callout variant="warn">
            You manage no shared workspace. Only owners and managers of a shared workspace can share
            connections into it.
          </Callout>
        ) : (
          <>
            <Select
              label="Share with"
              value={granteeType}
              onChange={(e) => toggleGranteeType(e.target.value)}
              options={[
                { value: "workspace", label: "A workspace" },
                { value: "user", label: "One member" },
              ]}
            />
            <Select
              label="Workspace"
              value={workspaceId}
              onChange={(e) => {
                setWorkspaceId(e.target.value);
                setGranteeUserId("");
              }}
              options={workspaceOptions}
            />
            {granteeType === "user" && (
              <Select
                label="Member"
                value={granteeUserId}
                onChange={(e) => setGranteeUserId(e.target.value)}
                options={userOptions}
                placeholder={membersError ? membersError : "Choose a member"}
              />
            )}
            <Input
              label="Limit models (optional)"
              value={modelsText}
              onChange={(e) => setModelsText(e.target.value)}
              placeholder="anthropic/claude-sonnet-4, openai/gpt-4o"
              hint="Empty means all models on the connection."
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label="Requests per minute (optional)"
                value={rpm}
                onChange={(e) => setRpm(e.target.value)}
                inputMode="numeric"
                placeholder="60"
              />
              <Input
                label="Tokens per minute (optional)"
                value={tpm}
                onChange={(e) => setTpm(e.target.value)}
                inputMode="numeric"
                placeholder="100000"
              />
            </div>
          </>
        )}

        {personal && (
          <Callout variant="warn" title="Provider terms apply">
            <p className="text-sm">{connection.sharingWarning}</p>
            <p className="mt-2 text-sm">
              <span className="sr-only">Terms links: </span>
              {TERMS_LINKS.map((link, index) => (
                <span key={link.href}>
                  {index > 0 && ", "}
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold underline"
                  >
                    {link.label}
                  </a>
                </span>
              ))}
            </p>
            {!isInstanceAdmin ? (
              <p className="mt-2 text-sm font-semibold">
                Only an instance owner or admin can share a subscription connection.
              </p>
            ) : policyAllowed === false ? (
              <p className="mt-2 text-sm font-semibold">
                Sharing subscription connections is turned off for this instance. An owner or admin
                can enable it in Settings under Security.
              </p>
            ) : null}
            <Checkbox
              className="mt-3"
              checked={acknowledged}
              onChange={setAcknowledged}
              label="I have read the warning above and accept the provider terms."
              disabled={!isInstanceAdmin || policyAllowed !== true}
            />
          </Callout>
        )}

        {errors.length > 0 && (
          <div role="alert" className="flex flex-col gap-1">
            {errors.map((error) => (
              <p key={error} className="text-sm text-err">
                {error}
              </p>
            ))}
          </div>
        )}
      </form>
    </Modal>
  );
}

ShareDialog.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  /** Connection row: id, provider, name, sharing, sharingWarning. */
  connection: PropTypes.shape({
    id: PropTypes.string.isRequired,
    provider: PropTypes.string.isRequired,
    name: PropTypes.string,
    sharing: PropTypes.string,
    sharingWarning: PropTypes.string,
  }),
  /** accountView().workspaces — caller's workspaces with kind and role. */
  workspaces: PropTypes.arrayOf(PropTypes.object),
  userId: PropTypes.string,
  isInstanceAdmin: PropTypes.bool,
  onShared: PropTypes.func,
};
