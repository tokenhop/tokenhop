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
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const CommandPaletteContext = createContext(null);

/** Read access to palette open state (e.g. the header trigger). */
export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}

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
  const { copy } = useCopyToClipboard();
  const listboxId = `palette-list-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const inputRef = useRef(null);

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
      closePalette();
      const run = command.run || {};
      if (run.type === "navigate" && run.href) router.push(run.href);
      else if (run.type === "copy-endpoint") {
        try {
          copy(`${window.location.origin}/v1`, "palette-endpoint");
        } catch {
          // Clipboard denied: toast layer already handles failure silently.
        }
      } else if (run.type === "toggle-theme") useThemeStore.getState().toggleTheme();
      else if (typeof command.run === "function") command.run();
    },
    [recents, closePalette, router, copy],
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

  const ranked = useMemo(() => filterAndRank(commands, query, recents), [commands, query, recents]);
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
        runCommand(ranked.find((c) => c.id === activeId) || ranked[0]);
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

  return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>;
}

CommandPaletteProvider.propTypes = {
  children: PropTypes.node,
};
