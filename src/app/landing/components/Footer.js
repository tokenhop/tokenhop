"use client";

import Link from "next/link";
import BrandLockup from "@/shared/components/BrandLockup";
import { ACTIVE, ACTIVE_BRAND_ID, BRAND, LEGACY } from "@/shared/brand";

const IS_TOKENHOP = ACTIVE_BRAND_ID === BRAND.slug;

const PRODUCT_LINKS = [
  { label: "Features", href: "#features" },
  { label: "Dashboard", href: "/dashboard" },
  {
    label: "Changelog",
    href: "https://github.com/tokenhop/tokenhop",
    target: "_blank",
    rel: "noopener noreferrer",
  },
];

const RESOURCE_LINKS = [
  {
    label: "Documentation",
    href: "https://github.com/tokenhop/tokenhop#readme",
    target: "_blank",
    rel: "noopener noreferrer",
  },
  {
    label: "GitHub",
    href: "https://github.com/tokenhop/tokenhop",
    target: "_blank",
    rel: "noopener noreferrer",
  },
  {
    label: "Docker",
    href: "https://github.com/tokenhop/tokenhop/pkgs/container/tokenhop",
    target: "_blank",
    rel: "noopener noreferrer",
  },
  ...(IS_TOKENHOP
    ? [
        {
          label: "npm",
          href: `https://www.npmjs.com/package/${BRAND.npmPackage}`,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      ]
    : []),
];

// The upstream project this fork is based on (MIT), credited on the tokenhop brand.
const UPSTREAM_CREDIT = IS_TOKENHOP
  ? {
      label: `Based on ${LEGACY.names[0]} by decolua`,
      href: `https://github.com/decolua/${LEGACY.slug}`,
    }
  : null;

const LEGAL_LINKS = [
  {
    label: "MIT License",
    href: "https://github.com/tokenhop/tokenhop/blob/master/LICENSE",
    target: "_blank",
    rel: "noopener noreferrer",
  },
];

/**
 * Landing footer: brand mark, links, license and copyright.
 */
export default function Footer() {
  return (
    <footer className="border-t border-line bg-raised/30 px-4 pt-16 pb-8 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-16 grid grid-cols-2 gap-8 md:grid-cols-4 lg:grid-cols-5">
          <div className="col-span-2 lg:col-span-2">
            <Link
              href="/"
              aria-label={`${ACTIVE.name} home`}
              className="mb-6 inline-flex min-h-[44px] items-center gap-3 rounded-lg"
            >
              <BrandLockup />
            </Link>
            <p className="mb-6 max-w-xs text-sm leading-relaxed text-muted">
              The unified endpoint for AI generation. Connect, route, and manage your AI providers
              with ease.
            </p>
            <div className="flex gap-4">
              <a
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted transition-colors hover:text-text focus-visible:shadow-focus"
                href="https://github.com/tokenhop/tokenhop"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="sr-only">{`${ACTIVE.name} on GitHub`}</span>
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                  code
                </span>
              </a>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <h2 className="font-sans text-sm font-semibold text-text">Product</h2>
            {PRODUCT_LINKS.map((link) => (
              <a
                key={link.label}
                className="inline-flex min-h-[44px] items-center text-sm text-muted transition-colors hover:text-coral focus-visible:shadow-focus"
                href={link.href}
                target={link.target}
                rel={link.rel}
              >
                {link.label}
              </a>
            ))}
          </div>

          <div className="flex flex-col gap-4">
            <h2 className="font-sans text-sm font-semibold text-text">Resources</h2>
            {RESOURCE_LINKS.map((link) => (
              <a
                key={link.label}
                className="inline-flex min-h-[44px] items-center text-sm text-muted transition-colors hover:text-coral focus-visible:shadow-focus"
                href={link.href}
                target={link.target}
                rel={link.rel}
              >
                {link.label}
              </a>
            ))}
          </div>

          <div className="flex flex-col gap-4">
            <h2 className="font-sans text-sm font-semibold text-text">Legal</h2>
            {LEGAL_LINKS.map((link) => (
              <a
                key={link.label}
                className="inline-flex min-h-[44px] items-center text-sm text-muted transition-colors hover:text-coral focus-visible:shadow-focus"
                href={link.href}
                target={link.target}
                rel={link.rel}
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-center justify-between gap-4 border-t border-line pt-8 sm:flex-row">
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted">{`© 2025 ${ACTIVE.name}. All rights reserved.`}</p>
            {UPSTREAM_CREDIT && (
              <a
                className="inline-flex min-h-[44px] items-center text-sm text-muted transition-colors hover:text-text focus-visible:shadow-focus"
                href={UPSTREAM_CREDIT.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {UPSTREAM_CREDIT.label}
              </a>
            )}
          </div>
          <div className="flex gap-6">
            <a
              className="inline-flex min-h-[44px] items-center text-sm text-muted transition-colors hover:text-text focus-visible:shadow-focus"
              href="https://github.com/tokenhop/tokenhop"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <a
              className="inline-flex min-h-[44px] items-center text-sm text-muted transition-colors hover:text-text focus-visible:shadow-focus"
              href="https://github.com/tokenhop/tokenhop/pkgs/container/tokenhop"
              target="_blank"
              rel="noopener noreferrer"
            >
              Docker
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
