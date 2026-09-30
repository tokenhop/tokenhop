"use client";

import { useEffect } from "react";
import { initRuntimeI18n, getCurrentLocale } from "./runtime";
import { RTL_LOCALES } from "./config";

/** Sync <html lang/dir> with the active locale (runtime i18n has no layout coupling). */
function syncDocumentLocale() {
  const locale = getCurrentLocale();
  const root = document.documentElement;
  root.lang = locale;
  root.dir = RTL_LOCALES.includes(locale) ? "rtl" : "ltr";
}

// Route changes need no re-walk: the runtime observer translates only the
// subtrees, text and attributes React mutates. LanguageSwitcher reloads on switch.
export function RuntimeI18nProvider({ children }) {
  useEffect(() => {
    initRuntimeI18n().then(syncDocumentLocale);
  }, []);

  return <>{children}</>;
}
