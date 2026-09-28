"use client";

import { useEffect, useState } from "react";
import ProviderIcon from "@/shared/components/ProviderIcon";

const CLI_TOOLS = [
  { id: "claude", name: "Claude Code", image: "/providers/claude.png" },
  { id: "codex", name: "OpenAI Codex", image: "/providers/codex.png" },
  { id: "cline", name: "Cline", image: "/providers/cline.png" },
  { id: "cursor", name: "Cursor", image: "/providers/cursor.png" },
];

const PROVIDERS = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "gemini", name: "Gemini" },
  { id: "github", name: "GitHub Copilot" },
];

const IN_PATHS = [
  "M 60 50 C 250 70, 250 180, 360 180",
  "M 60 140 C 250 140, 250 180, 360 180",
  "M 60 210 C 250 210, 250 180, 360 180",
  "M 60 300 C 250 280, 250 180, 360 180",
];

const OUT_PATHS = [
  "M 440 180 C 550 180, 550 50, 740 50",
  "M 440 180 C 550 180, 550 130, 740 130",
  "M 440 180 C 550 180, 550 230, 740 230",
  "M 440 180 C 550 180, 550 310, 740 310",
];

const chipClass = (active) =>
  active
    ? "border-lime-ink bg-lime-bg text-lime-ink ring-2 ring-lime-ink"
    : "border-line bg-raised text-text";

/**
 * Live routing diagram: CLI tools flow into the 9Router hub and out to one
 * lime-highlighted provider at a time. The rotation stops under reduced motion.
 * A screen-reader list describes the flow; phones get a stacked text diagram.
 */
export default function FlowAnimation() {
  const [activeFlow, setActiveFlow] = useState(0);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let interval = null;
    const sync = () => {
      clearInterval(interval);
      interval = media.matches
        ? null
        : setInterval(() => setActiveFlow((prev) => (prev + 1) % PROVIDERS.length), 2000);
    };
    sync();
    media.addEventListener("change", sync);
    return () => {
      clearInterval(interval);
      media.removeEventListener("change", sync);
    };
  }, []);

  return (
    <div className="w-full max-w-4xl">
      <ul className="sr-only">
        <li>Requests from Claude Code, OpenAI Codex, Cline and Cursor go to the 9Router hub.</li>
        <li>The hub routes each request to OpenAI, Anthropic, Gemini or GitHub Copilot.</li>
      </ul>

      {/* Mobile: stacked text diagram (the sr-only list above is the text alternative) */}
      <div aria-hidden="true" className="mx-auto flex max-w-md flex-col gap-2 px-4 md:hidden">
        <div className="grid grid-cols-2 gap-2">
          {CLI_TOOLS.map((tool) => (
            <span
              key={tool.id}
              className="rounded-lg border border-line bg-raised px-3 py-2 text-center text-sm font-medium text-text"
            >
              {tool.name}
            </span>
          ))}
        </div>
        <span
          className="material-symbols-outlined self-center text-[22px] text-subtle"
          aria-hidden="true"
        >
          arrow_downward
        </span>
        <span className="rounded-xl border-2 border-coral bg-panel px-4 py-3 text-center font-display text-base font-bold text-text">
          9Router hub
        </span>
        <span
          className="material-symbols-outlined self-center text-[22px] text-lime-ink"
          aria-hidden="true"
        >
          arrow_downward
        </span>
        <div className="grid grid-cols-2 gap-2">
          {PROVIDERS.map((provider, idx) => (
            <span
              key={provider.id}
              className={`rounded-lg border px-3 py-2 text-center text-sm font-semibold ${chipClass(activeFlow === idx)}`}
            >
              {provider.name}
            </span>
          ))}
        </div>
      </div>

      {/* Desktop diagram */}
      <div
        aria-hidden="true"
        className="relative mt-16 hidden h-[360px] w-full items-center justify-center md:flex"
      >
        <div className="relative z-20 flex size-32 flex-col items-center justify-center gap-1 rounded-full border-2 border-coral bg-panel shadow-card">
          <span className="material-symbols-outlined text-4xl text-coral">hub</span>
          <span className="text-xs font-bold tracking-widest text-text uppercase">9Router</span>
          <span className="absolute inset-0 rounded-full border border-coral opacity-40 motion-safe:animate-ping" />
        </div>

        <div className="absolute start-0 top-1/2 flex -translate-y-1/2 flex-col gap-7">
          {CLI_TOOLS.map((tool) => (
            <div
              key={tool.id}
              className="flex size-16 items-center justify-center overflow-hidden rounded-2xl border border-line bg-raised p-2"
            >
              <ProviderIcon
                src={tool.image}
                alt=""
                size={48}
                className="max-h-12 max-w-12 rounded-xl object-contain"
                fallbackText={tool.name.slice(0, 2).toUpperCase()}
              />
            </div>
          ))}
        </div>

        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 size-full rtl:-scale-x-100"
          viewBox="0 0 896 360"
          preserveAspectRatio="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {IN_PATHS.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              strokeDasharray="5 9"
              strokeWidth="2"
              className="stroke-subtle motion-safe:animate-flow"
            />
          ))}
          {OUT_PATHS.map((d, idx) => (
            <path
              key={d}
              d={d}
              fill="none"
              strokeDasharray={activeFlow === idx ? "5 9" : undefined}
              strokeWidth={activeFlow === idx ? 3 : 2}
              className={
                activeFlow === idx ? "stroke-lime-ink motion-safe:animate-flow" : "stroke-line"
              }
            />
          ))}
        </svg>

        <div className="absolute end-0 top-0 bottom-0 flex flex-col justify-between py-6">
          {PROVIDERS.map((provider, idx) => (
            <span
              key={provider.id}
              className={`flex min-w-[140px] items-center justify-center rounded-lg border px-4 py-2 text-xs font-bold transition-colors ${chipClass(activeFlow === idx)}`}
            >
              {provider.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
