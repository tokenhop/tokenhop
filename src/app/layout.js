import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import DensityApplier from "@/shared/components/DensityApplier";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/lib/reliability/initReliabilityPolicy"; // Load stored reliability overrides
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";
import { LOCALES, LOCALE_COOKIE, RTL_LOCALES } from "@/i18n/config";
import { ACTIVE } from "@/shared/brand";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

// Signal type system: Bricolage Grotesque (display), Geist (UI), Geist Mono
const bricolage = Bricolage_Grotesque({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-bricolage",
});

const geist = Geist({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-geist-mono",
});

// Material Symbols subset: only used glyphs, Signal axes pinned (scripts/icons-subset.mjs).
// `block` keeps ligature text invisible until the (small, preloaded) font arrives.
const materialSymbols = localFont({
  src: "./fonts/material-symbols-subset.woff2",
  display: "block",
  variable: "--font-icons",
  adjustFontFallback: false,
});

export const metadata = {
  title: "9Router - AI infrastructure management",
  description:
    "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
  icons: {
    icon: [{ url: ACTIVE.favicon, type: "image/svg+xml" }, { url: ACTIVE.faviconIco }],
  },
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f1ea" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0e12" },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      // next/font variables must live on <html>: --signal-font-* is declared on :root
      className={`${bricolage.variable} ${geist.variable} ${geistMono.variable} ${materialSymbols.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Apply persisted theme before first paint so a reload does not flash the
            default (dark) theme before the client store hydrates. Mirrors the
            zustand-persist "theme" key and the `dark` class applyTheme() sets. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static no-flash theme script, no user input
          dangerouslySetInnerHTML={{
            __html: `(function(){var r=document.documentElement;try{var s=localStorage.getItem('theme');var t=s?(JSON.parse(s).state||{}).theme:'dark';t=t||'dark';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t==='system'&&m)){r.classList.add('dark')}else{r.classList.remove('dark')}}catch(e){r.classList.add('dark')}try{var c=document.cookie.match(/(?:^|; )${LOCALE_COOKIE}=([^;]*)/);var l=c?decodeURIComponent(c[1]):'en';if(l==='zh')l='zh-CN';if(${JSON.stringify(LOCALES)}.indexOf(l)<0)l='en';r.lang=l;if(${JSON.stringify(RTL_LOCALES)}.indexOf(l)>=0)r.dir='rtl'}catch(e){}})();`,
          }}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static no-flash density script, no user input
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=document.cookie.match(/(?:^|; )nr-density=([^;]*)/);if(m&&decodeURIComponent(m[1])==='compact'){document.documentElement.classList.add('compact-density')}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <DensityApplier />
        <ThemeProvider>
          <RuntimeI18nProvider>{children}</RuntimeI18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
