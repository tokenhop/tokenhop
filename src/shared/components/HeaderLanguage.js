"use client";

import { useEffect, useState } from "react";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import { languageButtonLabel } from "@/shared/utils/shell";
import dynamic from "next/dynamic";
import IconButton from "./IconButton";

// Lazy popover: the visible trigger stays synchronous; the modal panel loads
// on first open. The `panelMounted` latch keeps the modal mounted across close
// so the shared Modal still returns focus and handles Esc.
const LanguageSwitcher = dynamic(() => import("./LanguageSwitcher"), { ssr: false });

function getLocaleFromCookie() {
  if (typeof document === "undefined") return "en";
  const cookie = document.cookie.split(";").find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : "en";
  return normalizeLocale(value);
}

/**
 * Signal language control: `translate` IconButton with a locale code chip and
 * an accessible name ("Language: English"). Opens the LanguageSwitcher modal.
 * No emoji: flag glyphs render as boxes without an emoji font. The label tracks
 * runtime locale changes (the modal switch reloads without a page reload).
 */
export default function HeaderLanguage() {
  const [open, setOpen] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);
  const [locale, setLocale] = useState("en");

  useEffect(() => {
    setLocale(getCurrentLocale() || getLocaleFromCookie());
    return onLocaleChange(() => setLocale(getCurrentLocale() || getLocaleFromCookie()));
  }, []);

  const { code, label } = languageButtonLabel(locale);

  return (
    <>
      <IconButton
        icon="translate"
        aria-label={label}
        onClick={() => {
          setPanelMounted(true);
          setOpen(true);
        }}
        data-i18n-skip="true"
        className="w-auto gap-1 px-2.5"
        suffix={
          <span className="font-mono text-xs font-semibold" aria-hidden="true">
            {code}
          </span>
        }
      />

      {panelMounted && (
        <LanguageSwitcher
          hideTrigger
          isOpen={open}
          onClose={() => {
            setOpen(false);
            setLocale(getCurrentLocale() || getLocaleFromCookie());
          }}
        />
      )}
    </>
  );
}
