"use client";

import { CopyField } from "@/shared/components";
import { ACTIVE } from "@/shared/brand";

// Published by this project on GHCR. (The npm package under the old upstream name is not ours.)
const INSTALL_COMMAND = `docker run -d -p 20128:20128 -v ~/.${ACTIVE.dataDirName}:/app/data -e INITIAL_PASSWORD=change-me ghcr.io/tokenhop/tokenhop`;

const STEPS = [
  {
    title: `Install ${ACTIVE.name}`,
    desc: "Run the Docker image to start the server instantly",
  },
  {
    title: "Open dashboard",
    desc: "Configure providers and API keys via web interface",
  },
  {
    title: "Route requests",
    desc: "Point your CLI tools to http://localhost:20128",
  },
];

const LOG_LINES = [
  { text: `Starting ${ACTIVE.name}...`, tone: "signal-terminal-log" },
  { text: "Server running on http://localhost:20128", tone: "signal-terminal-info" },
  { text: "Dashboard: http://localhost:20128/dashboard", tone: "signal-terminal-info" },
  { text: "Ready to route", tone: "signal-terminal-log" },
];

/**
 * Get-started section: three install steps beside a dark terminal card with a
 * copyable `docker run` command for this project's GHCR image.
 */
export default function GetStarted() {
  return (
    <section className="px-4 py-24 sm:px-6" id="get-started">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col items-start gap-16 lg:flex-row">
          <div className="flex-1">
            <p className="mb-2 text-xs font-semibold tracking-[0.08em] text-subtle uppercase">
              Get started
            </p>
            <h2 className="mb-6 font-display text-3xl font-bold tracking-[-0.02em] text-text md:text-4xl">
              Get started in 30 seconds
            </h2>
            <p className="mb-8 text-lg text-muted">
              {`Install ${ACTIVE.name}, configure your providers via web dashboard, and start routing AI requests.`}
            </p>

            <ol className="flex list-none flex-col gap-6 p-0">
              {STEPS.map((step, idx) => (
                <li key={step.title} className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="flex size-8 flex-none items-center justify-center rounded-full bg-coral-bg font-semibold text-coral-ink"
                  >
                    {idx + 1}
                  </span>
                  <div>
                    <h3 className="text-lg font-bold text-text">{step.title}</h3>
                    <p className="mt-1 text-sm text-muted">{step.desc}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {/* `dark` pins Signal tokens to dark values: the terminal is dark in both themes. */}
          <div className="dark w-full min-w-0 flex-1">
            <div className="signal-terminal overflow-hidden rounded-2xl border border-line shadow-card">
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <span aria-hidden="true" className="flex gap-2">
                  <span className="size-3 rounded-full bg-line" />
                  <span className="size-3 rounded-full bg-line" />
                  <span className="size-3 rounded-full bg-line" />
                </span>
                <span className="ms-2 font-mono text-xs text-muted">terminal</span>
              </div>

              <div className="overflow-x-auto p-6 font-mono text-sm leading-relaxed">
                <CopyField
                  value={`$ ${INSTALL_COMMAND}`}
                  copyValue={INSTALL_COMMAND}
                  label="Copy install command"
                  className="mb-6"
                />

                <p className="sr-only">
                  {`Starting ${ACTIVE.name}. Server running on http://localhost:20128. Dashboard at http://localhost:20128/dashboard. Ready to route.`}
                </p>
                <div aria-hidden="true" className="mb-6 flex flex-col gap-1">
                  {LOG_LINES.map((line) => (
                    <span key={line.text} className={line.tone}>
                      <span className="signal-terminal-time me-2">&gt;</span>
                      {line.text}
                    </span>
                  ))}
                </div>

                <p className="mb-2 border-t border-line pt-4 text-xs">
                  <span
                    className="material-symbols-outlined me-1 inline-block align-[-2px] text-[14px]"
                    aria-hidden="true"
                  >
                    edit_note
                  </span>
                  Configure providers in dashboard or use environment variables
                </p>

                <p className="text-xs">
                  <span className="signal-terminal-debug">Data location:</span>
                  <br />
                  <span className="signal-terminal-time">macOS/Linux:</span>{" "}
                  {`~/.${ACTIVE.dataDirName}/db/data.sqlite`}
                  <br />
                  <span className="signal-terminal-time">Windows:</span>{" "}
                  {`%APPDATA%/${ACTIVE.dataDirName}/db/data.sqlite`}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
