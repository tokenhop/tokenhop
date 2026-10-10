"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Button, Callout, Checkbox, Modal, MoveToWorkspaceDialog } from "@/shared/components";
import { Spinner } from "@/shared/components/Loading";
import { moveCapabilities } from "@/shared/utils/workspaceMove";

const CONNECTION_ITEM = [{ type: "connection" }];

const nameOf = (c) => c.name?.trim() || c.email?.trim() || c.displayName?.trim() || c.provider;

/**
 * Bulk "Move from Default" (YAN-701): pick connections that still live in the
 * shared Default workspace, then hand them to {@link MoveToWorkspaceDialog}.
 * Renders nothing unless the caller manages connections in Default and in at
 * least one other workspace.
 */
export default function MoveFromDefault({ view, onMoved }) {
  const defaultWs = useMemo(
    () => (view?.active ? (view.workspaces || []).find((w) => w.isDefault === true) : null),
    [view],
  );
  const caps = useMemo(() => moveCapabilities(CONNECTION_ITEM), []);
  const eligible = Boolean(
    defaultWs &&
      caps.every((cap) => view.can(cap, defaultWs.id)) &&
      (view.workspaces || []).some(
        (w) => w.id !== defaultWs.id && caps.every((cap) => view.can(cap, w.id)),
      ),
  );

  const [stage, setStage] = useState("closed"); // closed | pick | review
  const [rows, setRows] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [picked, setPicked] = useState(() => new Set());

  useEffect(() => {
    if (stage !== "pick" || !defaultWs) return;
    let cancelled = false;
    setRows(null);
    setLoadError("");
    setPicked(new Set());
    fetch(`/api/providers?workspaceId=${encodeURIComponent(defaultWs.id)}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) throw new Error("load");
        setRows(Array.isArray(data?.connections) ? data.connections : []);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load the default workspace's connections.");
      });
    return () => {
      cancelled = true;
    };
  }, [stage, defaultWs]);

  if (!eligible) return null;

  const toggle = (id, on) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const all = rows && rows.length > 0 && picked.size === rows.length;
  const items = (rows || [])
    .filter((c) => picked.has(c.id))
    .map((c) => ({ type: "connection", id: c.id, label: nameOf(c) }));

  return (
    <>
      <Button size="sm" variant="secondary" icon="sync_alt" onClick={() => setStage("pick")}>
        Move from default
      </Button>

      <Modal
        isOpen={stage === "pick"}
        onClose={() => setStage("closed")}
        title="Move from default"
        description="Choose the connections to move out of the default workspace."
        footer={
          <>
            <Button variant="ghost" onClick={() => setStage("closed")}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={items.length === 0}
              onClick={() => setStage("review")}
            >
              {items.length > 0 ? `Continue with ${items.length}` : "Continue"}
            </Button>
          </>
        }
      >
        {loadError ? (
          <Callout variant="err">{loadError}</Callout>
        ) : rows === null ? (
          <p className="flex items-center gap-2 text-sm text-muted" role="status">
            <Spinner size="sm" /> Loading connections…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">The default workspace has no connections left.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <Checkbox
              checked={all}
              indeterminate={!all && picked.size > 0}
              onChange={(on) => setPicked(on ? new Set(rows.map((c) => c.id)) : new Set())}
              label="Select all"
            />
            <ul className="m-0 flex list-none flex-col p-0">
              {rows.map((c) => (
                <li key={c.id}>
                  <Checkbox
                    checked={picked.has(c.id)}
                    onChange={(on) => toggle(c.id, on)}
                    label={nameOf(c)}
                    description={c.name?.trim() && c.provider ? c.provider : undefined}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>

      <MoveToWorkspaceDialog
        isOpen={stage === "review"}
        onClose={() => setStage("closed")}
        view={view}
        sourceWorkspaceId={defaultWs.id}
        sourceName={defaultWs.name}
        items={items}
        onMoved={() => {
          setStage("closed");
          onMoved?.();
        }}
      />
    </>
  );
}

MoveFromDefault.propTypes = {
  /** accountView(status). */
  view: PropTypes.object,
  onMoved: PropTypes.func,
};
