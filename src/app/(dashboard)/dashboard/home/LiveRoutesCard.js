"use client";

import dynamic from "next/dynamic";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { WidgetSkeleton } from "./WidgetStates";

// Lazy-load the SVG diagram (handbook: heavy client-only widgets load via next/dynamic).
const LiveRoutes = dynamic(() => import("./LiveRoutes"), {
  ssr: false,
  loading: () => <WidgetSkeleton lines={5} label="Loading live routes" />,
});

/** Home "Live routes" card: header pill + lazily loaded routes diagram. */
export function LiveRoutesCard(props) {
  return (
    <Card
      className="min-w-0 lg:col-span-2"
      title="Live routes"
      action={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-lime-bg px-2.5 py-1 text-xs font-semibold text-lime-ink">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-lime-ink motion-safe:animate-pulse"
          />
          last 5 min
        </span>
      }
    >
      <LiveRoutes {...props} />
    </Card>
  );
}

LiveRoutesCard.propTypes = {
  routes: PropTypes.shape({
    clients: PropTypes.arrayOf(PropTypes.object),
    providers: PropTypes.arrayOf(PropTypes.object),
    edges: PropTypes.arrayOf(PropTypes.object),
    fallbacks: PropTypes.arrayOf(PropTypes.object),
  }),
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
};
