"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import PropTypes from "prop-types";
import {
  collectCommands,
  createCachedLoader,
  eventShortcutFlags,
  filterAndRank,
  formatResultAnnouncement,
  groupResults,
  loadRecents,
  pushRecent,
  saveRecents,
  shouldOpenCommandPalette,
} from "@/shared/utils/commandPalette.js";
import {
  ensurePaletteSources,
  ensurePaletteVerbs,
  prefetchOnIdle,
} from "@/shared/utils/paletteLazy.js";
import useThemeStore from "@/store/themeStore";
import { useNotificationStore } from "@/store/notificationStore";
import { copyTextToClipboard } from "@/shared/components/formPrimitives";
import { GO_TO, matchGoTo } from "@/shared/utils/goToShortcuts";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";
import { withWorkspace } from "@/app/(dashboard)/dashboard/providers/connectTarget";
import Modal from "./Modal";
import dynamic from "next/dynamic";
import { getCurrentLocale } from "@/i18n/runtime";
import Kbd from "./Kbd";

// Lazy shell dialog: the chunk loads on first open, not with the shell.
const LanguageSwitcher = dynamic(() => import("./LanguageSwitcher"), { ssr: false });

const CommandPaletteContext = createContext(null);

/** Read access to palette open state (e.g. the header trigger). */
export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}

const CHEAT_ROWS = [...Object.entries(GO_TO), ["?", ["Keyboard shortcuts", null]]];

/**
 * `?` cheat sheet. Shared Modal gives focus trap, Esc, scroll lock, RTL.
 * @param {{ isOpen: boolean, onClose: () => void }} props
 */
export function ShortcutsDialog({ isOpen, onClose }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Keyboard shortcuts" size="sm">
      <dl className="flex flex-col gap-2.5">
        {[
          ["Command palette", ["⌘K", "Ctrl K"]],
          ["Search Providers or Settings", ["/"]],
          ["Move through results", ["↑", "↓"]],
          ["Run result", ["↵"]],
          ["Open a model's provider", ["⇧↵"]],
          ["Close dialog", ["Esc"]],
        ].map(([label, keys]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <dt className="text-sm text-text">{label}</dt>
            <dd className="m-0 flex gap-1">
              {keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dd>
          </div>
        ))}
        {CHEAT_ROWS.map(([keys, [label]]) => (
          <div key={keys} className="flex items-center justify-between gap-3">
            <dt className="text-sm text-text">{label}</dt>
            <dd className="m-0">
              <Kbd>{keys === "?" ? "?" : `g ${keys}`}</Kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

ShortcutsDialog.propTypes = {
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
};

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

// Cache per browser tab + workspace: providers/combos load on open, models lazily.
export function createDataCache() {
  let modelsLoader = createCachedLoader();
  let snapshot = { providers: null, combos: null, models: null };
  let cachedWorkspaceId = null;
  // Bumped on every workspace switch. A refresh that started under an older
  // generation must not write its result over the newer workspace's snapshot.
  let generation = 0;
  return {
    async refresh({ includeModels, forceProviders = false, workspaceId = null }) {
      if (cachedWorkspaceId !== workspaceId) {
        cachedWorkspaceId = workspaceId;
        generation += 1;
        snapshot = { providers: null, combos: null, models: null };
        modelsLoader = createCachedLoader();
        forceProviders = true;
      }
      const startGeneration = generation;
      const [providers, combos] = await Promise.all([
        forceProviders || snapshot.providers == null
          ? fetchJson(withWorkspace("/api/providers", workspaceId))
              .then((d) => d.connections || [])
              .catch(() => [])
          : snapshot.providers,
        snapshot.combos ??
          fetchJson(withWorkspace("/api/combos", workspaceId))
            .then((d) => d.combos || [])
            .catch(() => []),
      ]);
      let models = snapshot.models;
      if (includeModels && !models) {
        try {
          models = await modelsLoader(() =>
            fetchJson(withWorkspace("/api/models", workspaceId)).then((d) => d.models || []),
          );
          if (models === "fresh") models = snapshot.models;
        } catch {
          models = [];
        }
      }
      // Stale refresh (workspace switched mid-flight): discard success and
      // failure alike, leave the newer snapshot untouched. Callers are already
      // cancelled by their effect cleanup, so the returned value is ignored.
      if (startGeneration !== generation) return snapshot;
      snapshot = { providers, combos, models: models ?? snapshot.models };
      return snapshot;
    },
  };
}

async function runPaletteVerb(verb, helpers) {
  const {
    router: nav,
    navigate,
    notify: toast,
    announce: confirm,
    openShortcuts,
    openLanguage,
  } = helpers;
  // paletteVerbs.js loads with the rest of the palette heavies on first open.
  const verbs = await ensurePaletteVerbs();
  if (verb === "test-providers") {
    toast.info("Testing all providers");
    confirm("Testing all providers");
    const outcome = await verbs.testAllProviders();
    toast[outcome.level](outcome.message);
    confirm(outcome.message);
    return;
  }
  if (verb === "clear-console") {
    const outcome = await verbs.clearConsoleLog();
    toast[outcome.level](outcome.message);
    confirm(outcome.message);
    return;
  }
  if (verb === "sign-out") {
    const outcome = await verbs.signOut();
    if (outcome.level === "success") window.location.assign("/login");
    else {
      toast.error(outcome.message);
      confirm(outcome.message);
    }
    return;
  }
  if (verb === "change-language") {
    helpers.languageLocaleRef.current = getCurrentLocale();
    openLanguage();
    return;
  }
  if (verb === "toggle-tunnel") {
    const enabled = await verbs.readTunnelEnabled();
    if (enabled === null) {
      const outcome = { level: "error", message: "Could not read tunnel status" };
      toast.error(outcome.message);
      confirm(outcome.message);
      return;
    }
    const pending = enabled ? "Stopping tunnel" : "Starting tunnel. This can take 30 seconds.";
    toast.info(pending);
    confirm(pending);
    const outcome = await verbs.setTunnel(!enabled);
    toast[outcome.level === "warning" ? "warning" : outcome.level](outcome.message);
    confirm(outcome.message);
    return;
  }
  if (verb === "open-request-log") {
    navigate(() => nav.push("/dashboard/usage?tab=logs"), "/dashboard/usage?tab=logs");
  } else if (verb === "open-shortcuts") openShortcuts();
}

/**
 * Global ⌘K / Ctrl+K palette provider. Mount once in DashboardLayout.
 * @param {object} props
 * @param {React.ReactNode} props.children
 */
export function CommandPaletteProvider({ children }) {
  const router = useRouter();
  const routeGuardRef = useRef(null);
  const registerRouteGuard = useCallback((guard) => {
    routeGuardRef.current = guard;
    return () => {
      if (routeGuardRef.current === guard) routeGuardRef.current = null;
    };
  }, []);
  const navigate = useCallback((action, href) => {
    const guard = routeGuardRef.current;
    if (guard) guard.requestNavigation(action, href);
    else action();
  }, []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [commands, setCommands] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [recents, setRecents] = useState([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const cacheRef = useRef(null);
  if (!cacheRef.current) cacheRef.current = createDataCache();
  const notify = useNotificationStore();
  const { ready, scope } = useSettingsScope();
  const workspaceId = scope?.workspaceId;
  const listboxId = `palette-list-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const inputRef = useRef(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [languageMounted, setLanguageMounted] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const announce = useCallback((message) => setActionMessage(message), []);
  const pendingChord = useRef(null);
  const languageLocaleRef = useRef("en");
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = open;
  const [tunnelEnabled, setTunnelEnabled] = useState(null);

  // Idle-prefetch the palette heavies after mount so ⌘K stays imperceptible.
  useEffect(() => {
    const cancel = prefetchOnIdle(() => {
      ensurePaletteSources().catch(() => {});
      ensurePaletteVerbs().catch(() => {});
    });
    return cancel;
  }, []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setTunnelEnabled(null);
    ensurePaletteVerbs()
      .then(({ readTunnelEnabled }) => readTunnelEnabled())
      .then((enabled) => {
        if (active) setTunnelEnabled(enabled);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open]);

  const openPalette = useCallback(() => {
    // Already open: the [open] effect won't re-run, so don't reset its lists.
    if (!paletteOpenRef.current) {
      setCommands([]);
      setLoadingLists(true);
    }
    setOpen(true);
  }, []);
  const closePalette = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveId(null);
  }, []);

  useEffect(() => {
    try {
      setRecents(loadRecents());
    } catch {
      setRecents([]);
    }
  }, []);

  // Reset query on open, then pull provider/combo lists; models load lazily.
  // commandSources.js registers its static sources on import (exactly once);
  // the open-gate sets loadingLists so the dialog shows skeletons instead of
  // the "no results" empty state while sources are still loading.
  useEffect(() => {
    if (!open || !ready) return;
    setQuery("");
    setActiveId(null);
    let cancelled = false;
    setLoadingLists(true);
    ensurePaletteSources()
      .then(() =>
        cacheRef.current.refresh({ includeModels: false, forceProviders: true, workspaceId }),
      )
      .then((snapshot) => collectCommands(snapshot))
      .then((all) => {
        if (!cancelled) setCommands(all);
      })
      .catch(() => {
        if (cancelled) return;
        setCommands([]);
        useNotificationStore.getState().error("Couldn't load search results. Try again.");
        announce("Couldn't load search results");
      })
      .finally(() => {
        if (!cancelled) setLoadingLists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, ready, workspaceId, announce]);

  // Lazy models: fetch once the user starts typing (cached, shared inflight).
  // Debounced so typing does not refetch per keystroke; providers/combos
  // resolve from the open-time snapshot afterwards.
  useEffect(() => {
    if (!open || !query.trim() || !ready) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      ensurePaletteSources()
        .then(() => cacheRef.current.refresh({ includeModels: true, workspaceId }))
        .then((snapshot) => collectCommands(snapshot))
        .then((all) => {
          if (!cancelled) setCommands(all);
        })
        .catch(() => {});
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, ready, workspaceId]);

  const runCommand = useCallback(
    (command) => {
      if (!command) return;
      const next = pushRecent(recents, command.id);
      setRecents(next);
      saveRecents(window.localStorage, next);
      const run = command.run || {};
      if (typeof command.run === "function") {
        closePalette();
        command.run();
        return;
      }
      if (run.type === "navigate" && run.href) {
        closePalette();
        navigate(() => router.push(run.href), run.href);
        return;
      }
      if (run.type === "copy" || run.type === "copy-endpoint") {
        const value = run.type === "copy" ? run.value : `${window.location.origin}/v1`;
        copyTextToClipboard(value).then(
          () => {
            notify.success("Copied");
            announce("Copied");
          },
          () => {
            notify.error("Copy failed");
            announce("Copy failed");
          },
        );
        closePalette();
        return;
      }
      if (run.type === "toggle-theme") {
        useThemeStore.getState().toggleTheme();
        notify.success("Theme updated");
        announce("Theme updated");
        closePalette();
        return;
      }
      if (run.type === "verb") {
        // Loading the verbs chunk can fail (offline first visit). Surface it:
        // runPaletteVerb otherwise closes the palette and nothing happens.
        runPaletteVerb(run.verb, {
          router,
          navigate,
          notify,
          announce,
          openShortcuts: () => setShortcutsOpen(true),
          openLanguage: () => {
            setLanguageMounted(true);
            setLanguageOpen(true);
          },
          languageLocaleRef,
        }).catch(() => {
          notify.error("Action failed to load. Try again.");
          announce("Action failed to load");
        });
        closePalette();
        return;
      }
      closePalette();
    },
    [recents, closePalette, router, navigate, notify, announce],
  );

  // Global shortcut: ⌘K / Ctrl+K. Toggles even from the palette's own
  // input (the combobox guard would otherwise swallow the close). Ignored
  // while composing (IME), inside other editable fields, Monaco editors,
  // or when already handled.
  useEffect(() => {
    const isMonacoEditor = (node) =>
      Boolean(node?.closest?.(".monaco-editor, [data-monaco-editor]"));
    const inPaletteInput = (node) => Boolean(node?.closest?.("[data-command-palette]"));
    const onKeyDown = (event) => {
      const inOwnInput = inPaletteInput(event.target);
      const flags = eventShortcutFlags(inOwnInput ? { ...event, target: document.body } : event, {
        inCodeEditor: isMonacoEditor(event.target),
      });
      if (shouldOpenCommandPalette(flags)) {
        event.preventDefault();
        if (!paletteOpenRef.current) {
          setCommands([]);
          setLoadingLists(true);
        }
        setOpen((wasOpen) => !wasOpen);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // g chords and ?. Skip editors, modifier keys and any open dialog.
  useEffect(() => {
    const onKeyDown = (event) => {
      const flags = eventShortcutFlags(event);
      const blocked =
        flags.defaultPrevented ||
        flags.isComposing ||
        flags.inEditable ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        paletteOpenRef.current ||
        Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
      const result = matchGoTo(pendingChord.current, event.key, Date.now(), blocked);
      pendingChord.current = result.pending;
      if (result.help) {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (result.href) {
        event.preventDefault();
        navigate(() => router.push(result.href), result.href);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router, navigate]);

  const displayCommands = useMemo(
    () =>
      commands.map((command) =>
        command.id === "action:toggle-tunnel"
          ? {
              ...command,
              label: tunnelEnabled ? "Stop Cloudflare tunnel" : "Start Cloudflare tunnel",
              hint:
                tunnelEnabled === null
                  ? "Status unknown"
                  : tunnelEnabled
                    ? "Tunnel is on"
                    : "Tunnel is off",
              icon: tunnelEnabled ? "cloud_off" : "cloud_upload",
            }
          : command,
      ),
    [commands, tunnelEnabled],
  );
  const ranked = useMemo(
    () => filterAndRank(displayCommands, query, recents),
    [displayCommands, query, recents],
  );
  const groups = useMemo(() => groupResults(ranked), [ranked]);

  useEffect(() => {
    if (!open) return;
    setActiveId(ranked.length > 0 ? ranked[0].id : null);
  }, [open, ranked]);

  const moveActive = useCallback(
    (delta) => {
      if (ranked.length === 0) return;
      const index = Math.max(
        0,
        ranked.findIndex((c) => c.id === activeId),
      );
      const next = (index + delta + ranked.length) % ranked.length;
      setActiveId(ranked[next].id);
      document
        .getElementById(`palette-option-${ranked[next].id}`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [ranked, activeId],
  );

  const onInputKeyDown = useCallback(
    (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActive(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActive(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const command = ranked.find((c) => c.id === activeId) || ranked[0];
        runCommand(
          event.shiftKey && command?.secondary
            ? { ...command, run: command.secondary.run }
            : command,
        );
      }
    },
    [moveActive, runCommand, ranked, activeId],
  );

  const value = useMemo(
    () => ({
      open,
      openPalette,
      closePalette,
      query,
      setQuery,
      groups,
      total: ranked.length,
      activeId,
      setActiveId,
      runCommand,
      loadingLists,
      listboxId,
      inputRef,
      onInputKeyDown,
      openShortcuts: () => setShortcutsOpen(true),
      registerRouteGuard,
      announcement: open ? formatResultAnnouncement(ranked.length) : "",
    }),
    [
      registerRouteGuard,
      open,
      openPalette,
      closePalette,
      query,
      groups,
      ranked,
      activeId,
      runCommand,
      loadingLists,
      listboxId,
      onInputKeyDown,
    ],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <p role="status" aria-live="polite" className="sr-only">
        {actionMessage}
      </p>
      <ShortcutsDialog isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {languageMounted && (
        <LanguageSwitcher
          hideTrigger
          isOpen={languageOpen}
          onClose={(nextLocale) => {
            const changed = languageLocaleRef.current !== nextLocale;
            setLanguageOpen(false);
            if (changed) announce("Language updated");
          }}
        />
      )}
    </CommandPaletteContext.Provider>
  );
}

CommandPaletteProvider.propTypes = {
  children: PropTypes.node,
};
