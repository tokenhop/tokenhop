"use client";

import PropTypes from "prop-types";
import { Button, CopyField, StatusPill } from "@/shared/components";

/**
 * Landing hero: headline, endpoint promise, primary/secondary CTAs.
 *
 * @param {object} props
 * @param {string} [props.endpoint] Endpoint URL shown in the copy field.
 */
export default function HeroSection({ endpoint = "http://localhost:20128/v1" }) {
  return (
    <section className="relative flex min-h-[90vh] flex-col items-center justify-center overflow-hidden px-4 pt-32 pb-20 sm:px-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-coral-bg [mask-image:radial-gradient(ellipse_60%_100%_at_50%_0%,black,transparent)]"
      />

      <div className="relative z-10 flex w-full max-w-4xl flex-col items-center gap-8 text-center">
        <StatusPill variant="neutral" dot>
          Open source · MIT
        </StatusPill>

        <h1 className="font-display text-[42px] leading-[1.05] font-bold tracking-[-0.02em] text-balance text-text sm:text-5xl md:text-6xl">
          One endpoint for <br />
          <span className="text-coral">all AI providers</span>
        </h1>

        <p className="mx-auto max-w-2xl text-lg font-light text-muted md:text-xl">
          AI endpoint proxy with web dashboard - A JavaScript port of CLIProxyAPI. Works seamlessly
          with Claude Code, OpenAI Codex, Cline, RooCode, and other CLI tools.
        </p>

        <div className="w-full max-w-md">
          <CopyField value={endpoint} copyValue={endpoint} label="Copy endpoint URL" />
        </div>

        <div className="flex w-full flex-wrap items-center justify-center gap-4">
          <Button variant="primary" size="md" href="/dashboard" icon="rocket_launch">
            Get started
          </Button>
          <Button
            variant="secondary"
            size="md"
            href="https://github.com/yandy-r/9router"
            target="_blank"
            rel="noopener noreferrer"
            icon="code"
          >
            View on GitHub
          </Button>
        </div>
      </div>
    </section>
  );
}

HeroSection.propTypes = {
  endpoint: PropTypes.string,
};
