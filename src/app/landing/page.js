"use client";

import { Button } from "@/shared/components";
import Navigation from "./components/Navigation";
import HeroSection from "./components/HeroSection";
import FlowAnimation from "./components/FlowAnimation";
import HowItWorks from "./components/HowItWorks";
import Features from "./components/Features";
import GetStarted from "./components/GetStarted";
import Footer from "./components/Footer";

/**
 * Public landing page: hero + live routing diagram, get-started, how-it-works,
 * features and the closing call to action. Themed via Signal tokens.
 */
export default function LandingPage() {
  return (
    <div className="relative overflow-x-hidden bg-bg font-sans text-text antialiased">
      <div aria-hidden="true" className="landing-grid pointer-events-none fixed inset-0" />

      <Navigation />

      <main className="relative">
        <div className="relative">
          <HeroSection />
          <div className="flex justify-center pb-20">
            <FlowAnimation />
          </div>
        </div>

        <GetStarted />
        <HowItWorks />
        <Features />

        <section
          className="relative overflow-hidden px-4 py-24 sm:px-6"
          aria-labelledby="cta-title"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-coral-bg [mask-image:radial-gradient(ellipse_70%_100%_at_50%_100%,black,transparent)]"
          />
          <div className="relative z-10 mx-auto max-w-4xl text-center">
            <h2
              id="cta-title"
              className="mb-6 font-display text-4xl font-bold tracking-[-0.02em] text-text md:text-5xl"
            >
              Ready to simplify your AI infrastructure?
            </h2>
            <p className="mx-auto mb-10 max-w-2xl text-xl text-muted">
              Join developers who are streamlining their AI integrations with 9Router. Open source
              and free to start.
            </p>
            <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Button variant="primary" size="md" href="/dashboard" className="w-full sm:w-auto">
                Start free
              </Button>
              <Button
                variant="secondary"
                size="md"
                href="https://github.com/yandy-r/9router#readme"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full sm:w-auto"
              >
                Read documentation
              </Button>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
