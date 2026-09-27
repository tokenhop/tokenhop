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
import "@/shared/utils/commandSources.js";
import useThemeStore from "@/store/themeStore";
import { useNotificationStore } from "@/store/notificationStore";
import { copyTextToClipboard } from "@/shared/components/formPrimitives";
import { GO_TO, matchGoTo } from "@/shared/utils/goToShortcuts";
import {
  clearConsoleLog,
  readTunnelEnabled,
  setTunnel,
  signOut,
  testAllProviders,
} from "@/shared/utils/paletteVerbs";
import Modal from "./Modal";
import LanguageSwitcher from "./LanguageSwitcher";
import { getCurrentLocale } from "@/i18n/runtime";
import Kbd from "./Kbd";

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

// Cache per browser tab: providers/combos load on open, models lazily.
function createDataCache() {
  const modelsLoader = createCachedLoader();
  let snapshot = { providers: null, combos: null, models: null };
  return {
    async refresh({ includeModels, forceProviders = false }) {
      const [providers, combos] = await Promise.all([
        forceProviders || snapshot.providers == null
          ? fetchJson("/api/providers")
              .then((d) => d.connections || [])
              .catch(() => [])
          : snapshot.providers,
        snapshot.combos ??
          fetchJson("/api/combos")
            .then((d) => d.combos || [])
            .catch(() => []),
      ]);
      let models = snapshot.models;
      if (includeModels && !models) {
        try {
          models = await modelsLoader(() => fetchJson("/api/models").then((d) => d.models || []));
          if (models === "fresh") models = snapshot.models;
        } catch {
          models = [];
        }
      }
      snapshot = { providers, combos, models: models ?? snapshot.models };
      return snapshot;
    },
  };
}

async function runPaletteVerb(verb, helpers) {
  const { router: nav, notify: toast, announce: confirm, openShortcuts, openLanguage } = helpers;
  if (verb === "test-providers") {
    toast.info("Testing all providers");
    confirm("Testing all providers");
    const outcome = await testAllProviders();
    toast[outcome.level](outcome.message);
    confirm(outcome.message);
    return;
  }
  if (verb === "clear-console") {
    const outcome = await clearConsoleLog();
    toast[outcome.level](outcome.message);
    confirm(outcome.message);
    return;
  }
  if (verb === "sign-out") {
    const outcome = await signOut();
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
    const enabled = await readTunnelEnabled();
    if (enabled === null) {
      const outcome = { level: "error", message: "Could not read tunnel status" };
      toast.error(outcome.message);
      confirm(outcome.message);
      return;
    }
    const pending = enabled ? "Stopping tunnel" : "Starting tunnel. This can take 30 seconds.";
    toast.info(pending);
    confirm(pending);
    const outcome = await setTunnel(!enabled);
    toast[outcome.level === "warning" ? "warning" : outcome.level](outcome.message);
    confirm(outcome.message);
    return;
  }
  if (verb === "open-request-log") nav.push("/dashboard/usage?tab=logs");
  else if (verb === "open-shortcuts") openShortcuts();
}

/**
 * Global ⌘K / Ctrl+K palette provider. Mount once in DashboardLayout.
 * @param {object} props
 * @param {React.ReactNode} props.children
 */
export function CommandPaletteProvider({ children }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [commands, setCommands] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [recents, setRecents] = useState([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const cacheRef = useRef(null);
  if (!cacheRef.current) cacheRef.current = createDataCache();
  const notify = useNotificationStore();
  const listboxId = `palette-list-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const inputRef = useRef(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const announce = useCallback((message) => setActionMessage(message), []);
  const pendingChord = useRef(null);
  const languageLocaleRef = useRef("en");
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = open;
  const [tunnelEnabled, setTunnelEnabled] = useState(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setTunnelEnabled(null);
    readTunnelEnabled().then((enabled) => {
      if (active) setTunnelEnabled(enabled);
    });
    return () => {
      active = false;
    };
  }, [open]);

  const openPalette = useCallback(() => setOpen(true), []);
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
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveId(null);
    let cancelled = false;
    setLoadingLists(true);
    cacheRef.current
      .refresh({ includeModels: false, forceProviders: true })
      .then((snapshot) => collectCommands(snapshot))
      .then((all) => {
        if (!cancelled) setCommands(all);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingLists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Lazy models: fetch once the user starts typing (cached, shared inflight).
  // Debounced so typing does not refetch per keystroke; providers/combos
  // resolve from the open-time snapshot afterwards.
  useEffect(() => {
    if (!open || !query.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      cacheRef.current
        .refresh({ includeModels: true })
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
  }, [open, query]);

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
        router.push(run.href);
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
        runPaletteVerb(run.verb, {
          router,
          notify,
          announce,
          openShortcuts: () => setShortcutsOpen(true),
          openLanguage: () => setLanguageOpen(true),
          languageLocaleRef,
        });
        closePalette();
        return;
      }
      closePalette();
    },
    [recents, closePalette, router, notify, announce],
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
        router.push(result.href);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router]);

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
      announcement: open ? formatResultAnnouncement(ranked.length) : "",
    }),
    [
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
      <LanguageSwitcher
        hideTrigger
        isOpen={languageOpen}
        onClose={(nextLocale) => {
          const changed = languageLocaleRef.current !== nextLocale;
          setLanguageOpen(false);
          if (changed) announce("Language updated");
        }}
      />
    </CommandPaletteContext.Provider>
  );
}

CommandPaletteProvider.propTypes = {
  children: PropTypes.node,
};
