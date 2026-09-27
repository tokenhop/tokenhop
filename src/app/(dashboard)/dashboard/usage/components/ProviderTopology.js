"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import { ReactFlow, Handle, Position, Controls, BaseEdge, getBezierPath } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { useReducedMotion } from "@/shared/hooks/useOverlay";
import { topologyMotion } from "./topologyMotion";
import ProviderTile from "@/shared/components/ProviderTile";

// Force-stop FE animation if a provider stays active longer than this
const FE_ACTIVE_TIMEOUT_MS = 60000;
const FE_ACTIVE_TICK_MS = 1000;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { name: providerId };
}

// Custom provider node - rectangle with image + name
function ProviderNode({ data }) {
  const { label, providerId, active } = data;
  return (
    <div
      className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border-2 transition-all duration-300 bg-bg"
      style={{
        borderColor: active ? "var(--signal-lime-ink)" : "var(--signal-line)",
        minWidth: "150px",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Right}
        id="right"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      <ProviderTile providerId={providerId} size="md" />

      {/* Provider name */}
      <span
        className="text-base font-medium truncate"
        style={{ color: active ? "var(--signal-lime-ink)" : "var(--signal-text)" }}
      >
        {label}
      </span>

      {active && <span className="text-xs font-semibold text-lime-ink">Active</span>}
    </div>
  );
}

ProviderNode.propTypes = {
  data: PropTypes.object.isRequired,
};

// Center 9Router node — pulse/glow on card only (no expanding rings)
function RouterNode({ data }) {
  const powering = (data.activeCount || 0) > 0;
  return (
    <div
      className={`relative z-[1] flex items-center justify-center px-5 py-3 rounded-xl border-2 min-w-[130px] ${
        powering ? "border-lime-ink bg-lime-bg" : "border-coral bg-coral-bg"
      }`}
    >
      <Handle
        type="source"
        position={Position.Top}
        id="top"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      <img
        src="/favicon.svg"
        alt="9Router"
        className="w-6 h-6 me-2"
        loading="lazy"
        decoding="async"
      />
      <span className={`text-sm font-bold ${powering ? "text-lime-ink" : "text-coral-ink"}`}>
        9Router
      </span>
      {data.activeCount > 0 && (
        <span className="ms-2 rounded-full bg-lime px-1.5 py-0.5 text-xs font-bold text-on-lime">
          {data.activeCount}
        </span>
      )}
    </div>
  );
}

RouterNode.propTypes = {
  data: PropTypes.object.isRequired,
};

// Dashed lime flow is static under reduced motion, including after OS preference changes.
function TopologyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  data,
}) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={style}
      className={data?.flow ? "topology-edge-flow" : undefined}
    />
  );
}

TopologyEdge.propTypes = {
  id: PropTypes.string,
  sourceX: PropTypes.number,
  sourceY: PropTypes.number,
  targetX: PropTypes.number,
  targetY: PropTypes.number,
  sourcePosition: PropTypes.string,
  targetPosition: PropTypes.string,
  style: PropTypes.object,
  data: PropTypes.object,
};

const nodeTypes = { provider: ProviderNode, router: RouterNode };
const edgeTypes = { topology: TopologyEdge };

// Place N nodes evenly along an ellipse around the router center.
function buildLayout(providers, activeSet, lastSet, errorSet, flow) {
  const nodeW = 180;
  const nodeH = 30;
  const routerW = 120;
  const routerH = 44;
  const nodeGap = 24;

  const count = providers.length;

  // Compute rx so arc spacing between nodes >= nodeW + nodeGap
  const minRx = ((nodeW + nodeGap) * count) / (2 * Math.PI);
  const rx = Math.max(320, minRx);
  const ry = Math.max(200, rx * 0.55); // ellipse ratio ~0.55
  if (count === 0) {
    return {
      nodes: [
        {
          id: "router",
          type: "router",
          position: { x: 0, y: 0 },
          data: { activeCount: 0 },
          draggable: false,
        },
      ],
      edges: [],
    };
  }

  const nodes = [];
  const edges = [];

  nodes.push({
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    data: { activeCount: activeSet.size },
    draggable: false,
  });

  const edgeStyle = (active, last, error) => {
    if (error) return { stroke: "var(--signal-err)", strokeWidth: 2.5, strokeDasharray: "2 5" };
    if (active)
      return { stroke: "var(--signal-lime-ink)", strokeWidth: 3.5, strokeDasharray: "8 6" };
    if (last) return { stroke: "var(--signal-warn)", strokeWidth: 2, strokeDasharray: "3 6" };
    return { stroke: "var(--signal-line)", strokeWidth: 2 };
  };

  providers.forEach((p, i) => {
    const config = getProviderConfig(p.provider);
    const active = activeSet.has(p.provider?.toLowerCase());
    const last = !active && lastSet.has(p.provider?.toLowerCase());
    const error = !active && errorSet.has(p.provider?.toLowerCase());
    const nodeId = `provider-${p.provider}`;
    const data = {
      label:
        (config.name !== p.provider ? config.name : null) || p.nodeName || p.name || p.provider,
      providerId: p.provider,
      active,
    };

    // Distribute evenly starting from top (−π/2), clockwise
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    const cx = rx * Math.cos(angle);
    const cy = ry * Math.sin(angle);

    // Pick router handle closest to the node direction
    let sourceHandle, targetHandle;
    if (
      Math.abs(angle + Math.PI / 2) < Math.PI / 4 ||
      Math.abs(angle - (3 * Math.PI) / 2) < Math.PI / 4
    ) {
      sourceHandle = "top";
      targetHandle = "bottom";
    } else if (Math.abs(angle - Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "bottom";
      targetHandle = "top";
    } else if (cx > 0) {
      sourceHandle = "right";
      targetHandle = "left";
    } else {
      sourceHandle = "left";
      targetHandle = "right";
    }

    nodes.push({
      id: nodeId,
      type: "provider",
      position: { x: cx - nodeW / 2, y: cy - nodeH / 2 },
      data,
      draggable: false,
    });

    edges.push({
      id: `e-${nodeId}`,
      type: "topology",
      source: "router",
      sourceHandle,
      target: nodeId,
      targetHandle,
      animated: false,
      data: { flow: active && flow },
      style: edgeStyle(active, last, error),
    });
  });

  return { nodes, edges };
}

export default function ProviderTopology({
  providers = [],
  activeRequests = [],
  lastProvider = "",
  errorProvider = "",
}) {
  const reducedMotion = useReducedMotion();
  const motion = topologyMotion(reducedMotion);

  // Serialize to stable string keys so useMemo only re-runs when values actually change
  const activeKey = useMemo(
    () =>
      activeRequests
        .map((r) => r.provider?.toLowerCase())
        .filter(Boolean)
        .sort()
        .join(","),
    [activeRequests],
  );
  const lastKey = lastProvider?.toLowerCase() || "";
  const errorKey = errorProvider?.toLowerCase() || "";

  const rawActiveSet = useMemo(() => new Set(activeKey ? activeKey.split(",") : []), [activeKey]);
  const lastSet = useMemo(() => new Set(lastKey ? [lastKey] : []), [lastKey]);
  const errorSet = useMemo(() => new Set(errorKey ? [errorKey] : []), [errorKey]);

  // Track firstSeen per active provider; drop provider if running too long (BE stuck)
  const firstSeenRef = useRef({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const seen = firstSeenRef.current;
    const now = Date.now();
    for (const p of rawActiveSet) {
      if (!seen[p]) seen[p] = now;
    }
    for (const p of Object.keys(seen)) {
      if (!rawActiveSet.has(p)) delete seen[p];
    }
  }, [rawActiveSet]);

  useEffect(() => {
    if (rawActiveSet.size === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), FE_ACTIVE_TICK_MS);
    return () => clearInterval(id);
  }, [rawActiveSet]);

  const activeSet = useMemo(() => {
    const now = Date.now();
    const filtered = new Set();
    for (const p of rawActiveSet) {
      const ts = firstSeenRef.current[p];
      if (!ts || now - ts < FE_ACTIVE_TIMEOUT_MS) filtered.add(p);
    }
    return filtered;
  }, [rawActiveSet, tick]);

  const { nodes, edges } = useMemo(
    () => buildLayout(providers, activeSet, lastSet, errorSet, motion.flow),
    [providers, activeSet, lastSet, errorSet, motion.flow],
  );

  // Stable key — only remount when provider list changes
  const providersKey = useMemo(
    () =>
      providers
        .map((p) => p.provider)
        .sort()
        .join(","),
    [providers],
  );

  const rfInstance = useRef(null);
  const containerRef = useRef(null);
  const fitOpts = useMemo(
    () => ({ padding: 0.2, duration: motion.fitDuration }),
    [motion.fitDuration],
  );
  const onInit = useCallback(
    (instance) => {
      rfInstance.current = instance;
      setTimeout(() => instance.fitView(fitOpts), 50);
    },
    [fitOpts],
  );

  // Re-fit on container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (rfInstance.current) rfInstance.current.fitView(fitOpts);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitOpts]);

  // Re-fit when node count/layout changes
  useEffect(() => {
    if (rfInstance.current) {
      const id = setTimeout(() => rfInstance.current.fitView(fitOpts), 50);
      return () => clearTimeout(id);
    }
  }, [fitOpts]);

  return (
    <div
      ref={containerRef}
      className="h-[320px] w-full min-w-0 rounded-lg border border-line bg-raised/30 sm:h-[480px]"
    >
      {providers.length === 0 ? (
        <div className="h-full flex items-center justify-center text-muted text-sm">
          No providers connected
        </div>
      ) : (
        <ReactFlow
          key={providersKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={fitOpts}
          minZoom={0.1}
          maxZoom={2}
          onInit={onInit}
          attributionPosition="bottom-right"
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Controls showInteractive={false} className="react-flow-controls-custom" />
        </ReactFlow>
      )}
    </div>
  );
}

ProviderTopology.propTypes = {
  providers: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      provider: PropTypes.string,
      name: PropTypes.string,
    }),
  ),
  activeRequests: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string,
      model: PropTypes.string,
      account: PropTypes.string,
    }),
  ),
  lastProvider: PropTypes.string,
  errorProvider: PropTypes.string,
};
