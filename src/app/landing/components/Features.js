"use client";

const FEATURES = [
  {
    icon: "link",
    title: "Unified endpoint",
    desc: "Access all providers via a single standard API URL.",
  },
  {
    icon: "bolt",
    title: "Easy setup",
    desc: "Get up and running in minutes with one Docker command.",
  },
  {
    icon: "shield_with_heart",
    title: "Model fallback",
    desc: "Automatically switch providers on failure or high latency.",
  },
  {
    icon: "monitoring",
    title: "Usage tracking",
    desc: "Detailed analytics and cost monitoring across all models.",
  },
  {
    icon: "key",
    title: "OAuth & API keys",
    desc: "Securely manage credentials in one vault.",
  },
  {
    icon: "cloud_sync",
    title: "Cloud sync",
    desc: "Sync your configurations across devices instantly.",
  },
  {
    icon: "terminal",
    title: "CLI support",
    desc: "Works with Claude Code, Codex, Cline, Cursor, and more.",
  },
  {
    icon: "dashboard",
    title: "Dashboard",
    desc: "Visual dashboard for real-time traffic analysis.",
  },
];

/**
 * Feature grid: eight neutral cards with coral icon tiles.
 */
export default function Features() {
  return (
    <section className="px-4 py-24 sm:px-6" id="features">
      <div className="mx-auto max-w-7xl">
        <div className="mb-16">
          <p className="mb-2 text-xs font-semibold tracking-[0.08em] text-subtle uppercase">
            Features
          </p>
          <h2 className="mb-4 font-display text-3xl font-bold tracking-[-0.02em] text-text md:text-4xl">
            Powerful features
          </h2>
          <p className="max-w-xl text-lg text-muted">
            Everything you need to manage your AI infrastructure in one place, built for scale.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature) => (
            <article
              key={feature.title}
              className="rounded-2xl border border-line bg-panel p-6 shadow-card transition-colors hover:border-coral/40"
            >
              <div className="mb-4 flex size-10 items-center justify-center rounded-[10px] bg-coral-bg text-coral-ink">
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                  {feature.icon}
                </span>
              </div>
              <h3 className="mb-2 text-base font-semibold text-text">{feature.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{feature.desc}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
