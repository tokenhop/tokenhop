"use client";

import PropTypes from "prop-types";
import { Modal } from "@/shared/components";
import { LoadingState } from "@/shared/components/StateViews";
import { controlClass } from "./exampleShared";
import { filterLanguages } from "./ttsExampleLogic";

/**
 * Language picker modal for TTS cards with browsable voices (YAN-402).
 * Search filters by name or code; picking a language closes the modal and
 * loads that language's voices.
 */
export function TtsLanguageModal({
  open,
  onClose,
  search,
  onSearchChange,
  loading,
  error,
  languages,
  selectedLang,
  onPickLanguage,
}) {
  const filteredLanguages = filterLanguages(languages, search);

  return (
    <Modal isOpen={open} onClose={onClose} title="Select Language">
      <div className="flex flex-col">
        {/* Search */}
        <div className="border-b border-line px-4 py-2.5">
          <input
            aria-label="Search languages"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search language..."
            className={controlClass}
          />
        </div>

        {/* Language list */}
        <div className="overflow-y-auto flex-1 p-2">
          {error && (
            <p className="px-2 py-1 text-xs text-err" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <LoadingState lines={4} label="Loading languages" className="px-2 py-3" />
          ) : (
            <div className="flex flex-col gap-0.5">
              {filteredLanguages.map((c) => (
                <button
                  type="button"
                  key={c.code}
                  onClick={() => onPickLanguage(c)}
                  className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-start transition-colors hover:bg-raised focus-visible:shadow-focus ${
                    selectedLang === c.code ? "bg-coral-bg text-coral-ink" : "text-text"
                  }`}
                >
                  <span className="text-sm">{c.name}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted">{c.voices.length} voices</span>
                    {selectedLang === c.code && (
                      <span
                        className="material-symbols-outlined text-[16px] text-coral-ink"
                        aria-hidden="true"
                      >
                        check
                      </span>
                    )}
                  </div>
                </button>
              ))}
              {filteredLanguages.length === 0 && (
                <p className="text-xs text-muted px-2 py-3">No languages found.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

TtsLanguageModal.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  search: PropTypes.string,
  onSearchChange: PropTypes.func.isRequired,
  loading: PropTypes.bool,
  error: PropTypes.string,
  languages: PropTypes.array,
  selectedLang: PropTypes.string,
  onPickLanguage: PropTypes.func.isRequired,
};
