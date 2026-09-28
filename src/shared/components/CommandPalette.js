"use client";

import { useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import EmptyState from "./EmptyState";
import Kbd from "./Kbd";
import ProviderTile from "./ProviderTile";
import { useCommandPalette } from "./CommandPaletteProvider";

/**
 * Signal ⌘K command palette (YAN-294): APG combobox-in-dialog over the
 * shared Modal. Input is role=combobox with aria-activedescendant; results
 * are a grouped listbox; Enter runs, Esc closes (Modal dismiss layer), and
 * focus returns to the trigger via the shared focus trap. Mobile renders
 * near full-screen; layout uses logical props for RTL.
 */
export default function CommandPalette() {
  const palette = useCommandPalette();
  const open = Boolean(palette?.open);
  const inputRef = palette?.inputRef;

  useEffect(() => {
    if (open) inputRef?.current?.focus?.();
  }, [open, inputRef]);

  if (!palette) return null;
  return <CommandPaletteDialog palette={palette} />;
}

function CommandPaletteDialog({ palette }) {
  const {
    open,
    closePalette,
    query,
    setQuery,
    groups,
    total,
    activeId,
    setActiveId,
    runCommand,
    loadingLists,
    listboxId,
    inputRef,
    onInputKeyDown,
    openShortcuts,
    announcement,
  } = palette;

  return (
    <Modal
      isOpen={open}
      onClose={closePalette}
      aria-label="Command palette"
      size="lg"
      initialFocusRef={inputRef}
      className="max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:rounded-none"
    >
      <div className="flex min-h-0 flex-col" data-command-palette>
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <span className="material-symbols-outlined text-[20px] text-muted" aria-hidden="true">
            search
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeId ? `palette-option-${activeId}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Jump to provider, model, combo…"
            aria-label="Search commands, pages, providers, combos and models"
            autoComplete="off"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-subtle"
          />
          <button
            type="button"
            onClick={openShortcuts}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:text-text focus-visible:shadow-focus"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              keyboard
            </span>
          </button>
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="flex size-11 items-center justify-center rounded-lg text-muted hover:text-text"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                close
              </span>
            </button>
          ) : (
            <Kbd aria-hidden="true">esc</Kbd>
          )}
        </div>

        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>

        <div
          id={listboxId}
          role="listbox"
          aria-label="Commands"
          className="custom-scrollbar min-h-0 max-h-[60vh] flex-1 overflow-y-auto p-2 max-sm:max-h-none"
        >
          {loadingLists && total === 0 ? (
            <ul aria-hidden="true" className="flex flex-col gap-1.5 p-1">
              {[0, 1, 2, 3, 4].map((i) => (
                <li
                  key={i}
                  className="h-11 animate-pulse rounded-xl border border-line bg-raised"
                />
              ))}
            </ul>
          ) : total === 0 ? (
            <EmptyState
              icon="search_off"
              title="No matches"
              body={
                query
                  ? `Nothing matches “${query}”. Try a page, provider, combo or model.`
                  : "Type to search pages, providers, combos and models."
              }
            />
          ) : (
            groups.map((group) => (
              // biome-ignore lint/a11y/useSemanticElements: APG listbox grouping; native fieldset/legend cannot carry the combobox option-group semantics.
              <div key={group.group} role="group" aria-label={`${group.group}, ${group.count}`}>
                <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.1em] text-subtle uppercase">
                  {group.group}
                  <span className="ms-1.5 font-mono font-medium normal-case">{group.count}</span>
                </p>
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((command) => {
                    const active = command.id === activeId;
                    return (
                      <li key={command.id}>
                        <button
                          type="button"
                          tabIndex={-1}
                          id={`palette-option-${command.id}`}
                          role="option"
                          aria-selected={active}
                          onClick={(event) =>
                            runCommand(
                              event.shiftKey && command.secondary
                                ? { ...command, run: command.secondary.run }
                                : command,
                            )
                          }
                          onMouseEnter={() => setActiveId(command.id)}
                          onFocus={() => setActiveId(command.id)}
                          className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-start ${
                            active ? "bg-coral-bg text-text" : "text-text hover:bg-raised"
                          }`}
                        >
                          {command.providerId ? (
                            <ProviderTile providerId={command.providerId} size="sm" />
                          ) : (
                            <span
                              className="material-symbols-outlined shrink-0 text-[20px] text-muted"
                              aria-hidden="true"
                            >
                              {command.icon || "chevron_right"}
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {command.label}
                            </span>
                            {command.hint ? (
                              <span className="block truncate font-mono text-xs text-muted">
                                {command.hint}
                              </span>
                            ) : null}
                          </span>
                          {command.chord ? (
                            <span
                              className="hidden shrink-0 sm:inline-flex"
                              title={`Shortcut ${command.chord}`}
                            >
                              <Kbd>{command.chord}</Kbd>
                            </span>
                          ) : null}
                          {active ? (
                            <span
                              className="hidden shrink-0 items-center gap-1 sm:flex"
                              aria-hidden="true"
                            >
                              <Kbd>↵</Kbd>
                              {command.secondary ? (
                                <>
                                  <Kbd data-i18n-skip="true">⇧↵</Kbd>
                                  <span className="text-xs text-muted">
                                    {command.secondary.label}
                                  </span>
                                </>
                              ) : null}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

CommandPalette.propTypes = {};

CommandPaletteDialog.propTypes = {
  palette: PropTypes.shape({
    open: PropTypes.bool,
    closePalette: PropTypes.func,
    query: PropTypes.string,
    setQuery: PropTypes.func,
    groups: PropTypes.array,
    total: PropTypes.number,
    activeId: PropTypes.string,
    setActiveId: PropTypes.func,
    runCommand: PropTypes.func,
    loadingLists: PropTypes.bool,
    listboxId: PropTypes.string,
    inputRef: PropTypes.shape({ current: PropTypes.any }),
    onInputKeyDown: PropTypes.func,
    openShortcuts: PropTypes.func,
    announcement: PropTypes.string,
  }).isRequired,
};
