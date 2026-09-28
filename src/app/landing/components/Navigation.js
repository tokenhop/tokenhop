"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, IconButton, ThemeToggle } from "@/shared/components";

const NAV_LINKS = [
  { label: "Features", href: "#features" },
  { label: "How it Works", href: "#how-it-works" },
  {
    label: "Docs",
    href: "https://github.com/yandy-r/9router#readme",
    target: "_blank",
    rel: "noopener noreferrer",
  },
  {
    label: "GitHub",
    href: "https://github.com/yandy-r/9router",
    target: "_blank",
    rel: "noopener noreferrer",
    external: true,
  },
];

/**
 * Landing page header: brand mark, anchor links, theme toggle, primary CTA
 * and an Esc-dismissible mobile menu.
 */
export default function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileMenuOpen]);

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-line bg-panel/80 backdrop-blur-md">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6"
      >
        <Link
          href="/"
          aria-label="9Router home"
          className="flex min-h-[44px] items-center gap-3 rounded-lg"
        >
          <span
            className="-rotate-[8deg] flex size-9 items-center justify-center rounded-[11px] bg-coral font-display text-[22px] font-extrabold text-on-coral shadow-card"
            aria-hidden="true"
          >
            9
          </span>
          <span className="font-display text-[22px] font-bold tracking-[-0.02em] text-text">
            router
          </span>
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.target}
              rel={link.rel}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:text-text"
            >
              {link.label}
              {link.external && (
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                  open_in_new
                </span>
              )}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle className="min-h-[44px] min-w-[44px]" />
          <Button variant="primary" size="md" href="/dashboard" className="hidden sm:inline-flex">
            Get Started
          </Button>
          <IconButton
            icon={mobileMenuOpen ? "close" : "menu"}
            label={mobileMenuOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileMenuOpen}
            aria-controls="landing-mobile-menu"
            onClick={() => setMobileMenuOpen((open) => !open)}
            className="min-h-[44px] min-w-[44px] md:hidden"
          />
        </div>
      </nav>

      {mobileMenuOpen && (
        <div
          id="landing-mobile-menu"
          className="border-t border-line bg-panel/95 backdrop-blur-md md:hidden"
        >
          <div className="flex flex-col gap-1 p-4 sm:p-6">
            {NAV_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target={link.target}
                rel={link.rel}
                onClick={() => setMobileMenuOpen(false)}
                className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:text-text"
              >
                {link.label}
              </a>
            ))}
            <Button variant="primary" size="md" href="/dashboard" fullWidth className="mt-2">
              Get Started
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
