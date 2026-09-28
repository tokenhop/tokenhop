"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { initRuntimeI18n, reloadTranslations, getCurrentLocale } from "./runtime";
import { RTL_LOCALES } from "./config";

/** Sync <html lang/dir> with the active locale (runtime i18n has no layout coupling). */
function syncDocumentLocale() {
  const locale = getCurrentLocale();
  const root = document.documentElement;
  root.lang = locale;
  root.dir = RTL_LOCALES.includes(locale) ? "rtl" : "ltr";
}

export function RuntimeI18nProvider({ children }) {
  const pathname = usePathname();

  useEffect(() => {
    initRuntimeI18n();
    syncDocumentLocale();
  }, []);

  // Re-process DOM when route changes
  useEffect(() => {
    if (pathname) {
      // Double RAF to ensure React has committed changes to DOM
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          reloadTranslations();
          syncDocumentLocale();
        });
      });
    }
  }, [pathname]);

  return <>{children}</>;
}
