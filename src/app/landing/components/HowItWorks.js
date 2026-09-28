"use client";

/**
 * How-it-works section: three steps from CLI tools through the hub to providers.
 */
export default function HowItWorks() {
  return (
    <section className="border-y border-line bg-raised/40 py-24" id="how-it-works">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mb-16">
          <p className="mb-2 text-xs font-semibold tracking-[0.08em] text-subtle uppercase">
            How it works
          </p>
          <h2 className="mb-4 font-display text-3xl font-bold tracking-[-0.02em] text-text md:text-4xl">
            How 9Router works
          </h2>
          <p className="max-w-xl text-lg text-muted">
            Data flows seamlessly from your application through our intelligent routing layer to the
            best provider for the job.
          </p>
        </div>

        <div className="relative grid grid-cols-1 gap-8 md:grid-cols-3">
          <div
            aria-hidden="true"
            className="absolute top-12 start-[16%] end-[16%] hidden h-[2px] bg-line md:block"
          />

          <div className="relative flex flex-col gap-6">
            <div className="z-10 mx-auto flex h-24 w-24 items-center justify-center rounded-2xl border border-line bg-panel shadow-card md:mx-0">
              <span className="material-symbols-outlined text-4xl text-muted" aria-hidden="true">
                terminal
              </span>
            </div>
            <div className="text-start">
              <h3 className="mb-2 text-xl font-bold text-text">1. CLI &amp; SDKs</h3>
              <p className="text-sm text-muted">
                Your requests start from your favorite tools or our unified SDK. Just change the
                base URL.
              </p>
            </div>
          </div>

          <div className="relative flex flex-col gap-6 md:items-center md:text-center">
            <div className="z-10 mx-auto flex h-24 w-24 items-center justify-center rounded-2xl border-2 border-coral bg-panel shadow-card">
              <span
                className="material-symbols-outlined text-4xl text-coral motion-safe:animate-pulse motion-reduce:animate-none"
                aria-hidden="true"
              >
                hub
              </span>
            </div>
            <div className="text-start md:text-center">
              <h3 className="mb-2 text-xl font-bold text-coral">2. 9Router hub</h3>
              <p className="text-sm text-muted">
                Our engine analyzes the prompt, checks provider health, and routes for lowest
                latency or cost.
              </p>
            </div>
          </div>

          <div className="relative flex flex-col gap-6 md:items-end md:text-end">
            <div className="z-10 mx-auto flex h-24 w-24 items-center justify-center rounded-2xl border border-line bg-panel shadow-card md:mx-0">
              <span className="material-symbols-outlined text-4xl text-muted" aria-hidden="true">
                cloud
              </span>
            </div>
            <div className="text-start md:text-end">
              <h3 className="mb-2 text-xl font-bold text-text">3. AI providers</h3>
              <p className="text-sm text-muted">
                The request is fulfilled by OpenAI, Anthropic, Gemini, or others instantly.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
