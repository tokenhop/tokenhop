"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { LOCALES, LOCALE_COOKIE, normalizeLocale, RTL_LOCALES } from "@/i18n/config";
import { reloadTranslations, getCurrentLocale } from "@/i18n/runtime";
import Modal from "./Modal";

function getLocaleFromCookie() {
  if (typeof document === "undefined") return "en";
  const cookie = document.cookie.split(";").find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : "en";
  return normalizeLocale(value);
}

// Locale display names. The panel carries data-i18n-skip so the runtime
// never rewrites these native labels, independent of the active language.
const LOCALE_NAMES = {
  en: "English",
  vi: "Tiếng Việt",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  "pt-BR": "Português (Brasil)",
  "pt-PT": "Português (Portugal)",
  ko: "한국어",
  es: "Español",
  de: "Deutsch",
  fr: "Français",
  he: "עברית",
  ar: "العربية",
  ru: "Русский",
  pl: "Polski",
  cs: "Čeština",
  nl: "Nederlands",
  tr: "Türkçe",
  uk: "Українська",
  tl: "Tagalog",
  id: "Indonesia",
  th: "ไทย",
  km: "ខ្មែរ",
  hi: "हिन्दी",
  bn: "বাংলা",
  ur: "اردو",
  ro: "Română",
  sv: "Svenska",
  it: "Italiano",
  el: "Ελληνικά",
  hu: "Magyar",
  fi: "Suomi",
  da: "Dansk",
  no: "Norsk",
  fa: "فارسی",
};

const localeName = (locale) => LOCALE_NAMES[locale] || locale;

/**
 * Language picker: trigger button plus a shared-Modal grid of locales.
 * Posts `/api/locale`, reloads translations without a page reload and keeps
 * `document.lang`/`dir` in sync. Supports a controlled `isOpen` (Header
 * language popover uses `onClose(nextLocale)`) or its own trigger.
 *
 * @param {object} props
 * @param {string} [props.className]
 * @param {boolean} [props.isOpen] Controlled open state.
 * @param {(locale: string) => void} [props.onClose] Controlled close callback.
 * @param {boolean} [props.hideTrigger] Render only the dialog (controlled mode).
 */
export default function LanguageSwitcher({
  className = "",
  isOpen: controlledOpen,
  onClose,
  hideTrigger = false,
}) {
  const [locale, setLocale] = useState("en");
  const [isPending, setIsPending] = useState(false);
  const [internalOpen, setInternalOpen] = useState(false);

  const isControlled = typeof controlledOpen === "boolean";
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const close = (nextLocale = locale) => {
    if (isControlled) onClose?.(nextLocale);
    else setInternalOpen(false);
  };

  useEffect(() => {
    setLocale(getLocaleFromCookie());
  }, []);

  const handleSetLocale = async (nextLocale) => {
    if (nextLocale === locale || isPending) return;
    setIsPending(true);
    try {
      await fetch("/api/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: nextLocale }),
      });
      await reloadTranslations();
      const root = document.documentElement;
      const active = getCurrentLocale();
      root.lang = active;
      root.dir = RTL_LOCALES.includes(active) ? "rtl" : "ltr";
      setLocale(nextLocale);
      close(nextLocale);
    } catch (err) {
      console.error("Failed to set locale:", err);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className={className}>
      {!hideTrigger && (
        <button
          type="button"
          onClick={() => setInternalOpen(!internalOpen)}
          disabled={isPending}
          className="flex h-11 items-center gap-2 rounded-lg px-3 text-muted transition-colors hover:bg-raised hover:text-text"
          title="Language"
        >
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            language
          </span>
          <span className="text-sm font-medium">{localeName(locale)}</span>
        </button>
      )}
      <Modal
        isOpen={isOpen}
        onClose={() => close()}
        title="Select Language"
        size="full"
        className="max-w-2xl"
      >
        <div
          data-i18n-skip="true"
          className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2"
        >
          {LOCALES.map((item) => {
            const active = locale === item;
            return (
              <button
                key={item}
                type="button"
                onClick={() => handleSetLocale(item)}
                disabled={isPending}
                aria-current={active || undefined}
                title={localeName(item)}
                className={`flex w-full flex-col items-center justify-start gap-1 rounded-lg px-2 py-3 text-xs font-medium transition-colors ${
                  active ? "bg-coral-bg text-coral shadow-focus" : "text-text hover:bg-raised"
                } ${isPending ? "cursor-wait opacity-70" : ""}`}
              >
                <span className="material-symbols-outlined text-[26px]" aria-hidden="true">
                  {active ? "language" : "translate"}
                </span>
                <span className="flex h-8 items-center overflow-hidden text-center leading-tight [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                  {localeName(item)}
                </span>
                {active && (
                  <span className="material-symbols-outlined text-sm" aria-hidden="true">
                    check
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Modal>
    </div>
  );
}

LanguageSwitcher.propTypes = {
  className: PropTypes.string,
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
  hideTrigger: PropTypes.bool,
};
