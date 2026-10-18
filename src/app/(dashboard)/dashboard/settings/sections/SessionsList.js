"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { translate } from "@/i18n/runtime";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import Callout from "@/shared/components/Callout";
import { Skeleton } from "@/shared/components/Loading";
import { ConfirmDialog } from "@/shared/components/Modal";
import { fetchSessions, revokeSession, signOut } from "@/shared/utils/accountApi";
import {
  deviceIcon,
  fill,
  formatLastActive,
  formatSessionDate,
  lastActiveAt,
  methodLabel,
  sortSessions,
} from "@/shared/utils/sessions";

const FOCUS_REFRESH_MS = 30_000;
const TOUCH = "min-h-11 sm:min-h-0";
const toLogin = () => window.location.assign("/login");
const deviceName = (s) => s.device || translate("Unknown device");

/**
 * My account → Sessions (YAN-751): this account's signed-in browsers and
 * devices, with per-device sign out. Other devices sign out at once; this
 * device asks first because it leaves the page.
 */
export default function SessionsList({ loginMethod, reloadKey = 0 }) {
  const headingId = useId();
  const headingRef = useRef(null);
  const buttons = useRef(new Map());
  const focusNext = useRef(undefined);
  const lastLoad = useRef(0);
  const seq = useRef(0);
  const rowsRef = useRef([]);
  const [sessions, setSessions] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [rowErrors, setRowErrors] = useState({});
  const [status, setStatus] = useState("");
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState("");

  // Quiet: keeps the previous list on screen (no skeleton flash).
  const load = useCallback(async () => {
    lastLoad.current = Date.now();
    const n = ++seq.current;
    try {
      const data = await fetchSessions();
      if (n !== seq.current) return;
      setSessions(sortSessions(data.sessions));
      setLoadError("");
    } catch (err) {
      if (n !== seq.current) return;
      if (err.status === 401) {
        // A legacy owner token has no session id, so the sessions API answers
        // 401 while the login is still valid: only leave when it really isn't.
        let authenticated = false;
        try {
          const res = await fetch("/api/auth/status", { cache: "no-store" });
          authenticated = res.ok && (await res.json())?.authenticated === true;
        } catch {}
        if (n !== seq.current) return;
        if (!authenticated) return toLogin();
        // Legacy token: show the "This browser" fallback row.
        setLoadError("");
        return setSessions([]);
      }
      setLoadError(
        err.status === 404
          ? translate("Sessions aren't available right now.")
          : err.message || translate("Could not load sessions."),
      );
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey bumps after an unlink re-mints the cookie
  useEffect(() => {
    load();
  }, [load, reloadKey]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible" || confirmTarget) return;
      if (Date.now() - lastLoad.current >= FOCUS_REFRESH_MS) load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load, confirmTarget]);

  // The clicked button is gone after a revoke: move focus to a neighbour.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the removed row has left the DOM
  useEffect(() => {
    if (focusNext.current === undefined) return;
    const id = focusNext.current;
    focusNext.current = undefined;
    (buttons.current.get(id) || headingRef.current)?.focus();
  }, [sessions]);

  // Drop the row, announce, then refresh quietly in the background.
  const dropRow = (id, message) => {
    seq.current++; // discard loads that started before this revoke
    const ids = rowsRef.current.map((s) => s.id);
    const at = ids.indexOf(id);
    focusNext.current = ids[at + 1] ?? ids[at - 1] ?? null;
    setStatus(message);
    setSessions((list) => list?.filter((s) => s.id !== id) ?? list);
    load();
  };

  const revokeOther = async (session) => {
    const name = deviceName(session);
    setBusyIds((ids) => new Set(ids).add(session.id));
    setRowErrors(({ [session.id]: _, ...rest }) => rest);
    try {
      await revokeSession(session.id);
      dropRow(
        session.id,
        fill(translate("Signed out {device}. It may take a few seconds to take effect."), {
          device: name,
        }),
      );
    } catch (err) {
      if (err.status === 401) return toLogin();
      // 404 is one answer for unknown/expired/already revoked: the goal is met.
      if (err.status === 404)
        return dropRow(
          session.id,
          fill(translate("{device} was already signed out."), { device: name }),
        );
      const message = fill(translate("Could not sign out {device}. Try again."), {
        device: name,
      });
      setRowErrors((all) => ({ ...all, [session.id]: message }));
    } finally {
      setBusyIds((ids) => {
        const next = new Set(ids);
        next.delete(session.id);
        return next;
      });
    }
  };

  // Stays loading until the browser leaves for /login.
  const revokeCurrent = async () => {
    setConfirmBusy(true);
    setConfirmError("");
    try {
      if (confirmTarget.legacy) await signOut();
      else await revokeSession(confirmTarget.id);
      toLogin();
    } catch (err) {
      if (err.status === 401 || err.status === 404) return toLogin();
      setConfirmError(err.message || translate("Could not sign out this device."));
      setConfirmBusy(false);
    }
  };

  const hasCurrent = sessions?.some((s) => s.current);
  const legacy = { id: "legacy", legacy: true, current: true, device: translate("This browser") };
  const rows = sessions ? [...(hasCurrent ? [] : [legacy]), ...sessions] : [];
  rowsRef.current = rows;

  const renderRow = (s) => {
    const method = s.legacy ? null : methodLabel(s.loginMethod);
    const active = lastActiveAt(s);
    const name = deviceName(s);
    return (
      <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
        <span
          className="material-symbols-outlined grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-[20px] text-muted"
          aria-hidden="true"
        >
          {s.legacy ? "web" : deviceIcon(s.device)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-text">{name}</p>
            {s.current && (
              <Badge variant="ok" size="sm" dot>
                This device
              </Badge>
            )}
            {method && (
              <Badge variant="neutral" size="sm" icon="login">
                {method}
              </Badge>
            )}
          </div>
          {s.legacy ? (
            <>
              <p className="text-xs text-muted">
                {fill(translate("Signed in with {method}. Sign out ends this browser only."), {
                  method: loginMethod,
                })}
              </p>
              <p className="text-xs text-subtle">
                Per-device details appear after your next sign-in.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted">
              {s.network && (
                <span>{`${fill(translate("Network {ip}"), { ip: s.network })} · `}</span>
              )}
              <time dateTime={s.createdAt} title={formatSessionDate(s.createdAt)}>
                {fill(translate("Signed in {date}"), { date: formatSessionDate(s.createdAt) })}
              </time>
              {" · "}
              <time dateTime={active ?? undefined} title={formatSessionDate(active)}>
                {formatLastActive(active)}
              </time>
            </p>
          )}
          {rowErrors[s.id] && (
            <p role="alert" className="mt-1 text-xs text-err">
              {rowErrors[s.id]}
            </p>
          )}
        </div>
        <Button
          ref={(el) => {
            if (el) buttons.current.set(s.id, el);
            else buttons.current.delete(s.id);
          }}
          variant="ghost"
          size="sm"
          icon="logout"
          className={TOUCH}
          loading={busyIds.has(s.id)}
          aria-label={
            s.current
              ? fill(translate("Sign out this device, {device}"), { device: name })
              : fill(translate("Sign out {device}"), { device: name })
          }
          onClick={() => (s.current ? setConfirmTarget(s) : revokeOther(s))}
        >
          Sign out
        </Button>
      </li>
    );
  };

  return (
    <section aria-labelledby={headingId} aria-busy={!sessions && !loadError}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-[15px] font-semibold text-text focus:outline-none"
          >
            Sessions
          </h3>
          <p className="mt-0.5 text-[13px] text-muted">
            Browsers and devices signed in to your account.
          </p>
        </div>
        <Button variant="ghost" size="sm" icon="refresh" className={TOUCH} onClick={load}>
          Refresh
        </Button>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      {loadError && (
        <Callout variant="err" title="Could not load sessions" className="mt-3">
          {loadError}{" "}
          <Button variant="ghost" size="sm" onClick={load}>
            Retry
          </Button>
        </Callout>
      )}
      {!sessions && !loadError && <Skeleton className="mt-3 h-16" />}
      {sessions && (
        <>
          <ul aria-labelledby={headingId} className="mt-2 divide-y divide-line">
            {rows.map(renderRow)}
          </ul>
          {!sessions.some((s) => !s.current) && (
            <p className="text-[13px] text-muted">No other devices are signed in.</p>
          )}
          <p className="mt-1 text-[13px] text-muted">
            Don't recognise a device? Sign it out, then change your password.
          </p>
        </>
      )}
      <ConfirmDialog
        isOpen={Boolean(confirmTarget)}
        onClose={() => {
          setConfirmTarget(null);
          setConfirmError("");
        }}
        onConfirm={revokeCurrent}
        title="Sign out this device?"
        message="You'll be signed out of this browser and taken to the sign-in page. Your other devices stay signed in."
        confirmText="Sign out"
        cancelText="Cancel"
        variant="danger"
        loading={confirmBusy}
        error={confirmError || undefined}
      />
    </section>
  );
}
