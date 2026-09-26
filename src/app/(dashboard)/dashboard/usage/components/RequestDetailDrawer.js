"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Drawer from "@/shared/components/Drawer";
import StatusPill from "@/shared/components/StatusPill";
import ProviderTile from "@/shared/components/ProviderTile";
import EmptyState from "@/shared/components/EmptyState";
import CopyField from "@/shared/components/CopyField";
import { buildCurl } from "../lib/usageShapes";

const getCached = (t) => t?.cached_tokens || t?.cache_read_input_tokens || 0;
const getCacheWrite = (t) => t?.cache_creation_input_tokens || 0;
const getInput = (t) => {
  const prompt = t?.prompt_tokens || t?.input_tokens || 0;
  const cache = getCached(t);
  return prompt < cache ? cache : prompt;
};
const getOutput = (t) => t?.completion_tokens || t?.output_tokens || 0;

const SECTIONS = [
  { key: "request", title: "1 · Client request" },
  { key: "providerRequest", title: "2 · Provider request (translated)" },
  { key: "providerResponse", title: "3 · Provider response (raw)" },
  { key: "response", title: "4 · Client response (final)" },
];

function Collapsible({ title, open, children, resetKey }) {
  // Open-state resets when a different request is selected (titles are
  // request-stable, so reset on resetKey = detail.id).
  const [isOpen, setIsOpen] = useState(open);
  const [lastKey, setLastKey] = useState(resetKey);
  if (resetKey !== lastKey) {
    setLastKey(resetKey);
    setIsOpen(open);
  }
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between bg-raised p-3 transition-colors hover:bg-line/40"
      >
        <span className="text-sm font-semibold">{title}</span>
        <span
          aria-hidden="true"
          className={`material-symbols-outlined text-[20px] text-muted transition-transform ${isOpen ? "rotate-90" : ""}`}
        >
          chevron_right
        </span>
      </button>
      {isOpen && <div className="border-t border-line p-4">{children}</div>}
    </div>
  );
}

Collapsible.propTypes = {
  title: PropTypes.node.isRequired,
  open: PropTypes.bool,
  children: PropTypes.node,
  resetKey: PropTypes.string,
};

function isRedacted(v) {
  return v && typeof v === "object" && v.redacted === true && Object.keys(v).length === 1;
}

/**
 * Signal Drawer (width lg) for one request detail. Server redacts payloads
 * (see /api/usage/request-details): metadata/tokens/latency/PXPIPE render
 * when present, redacted sections show an EmptyState. Copy-as-cURL renders
 * only when a full request payload is present; there is no Replay button
 * because no safe replay mechanism exists.
 *
 * @param {object} props
 * @param {object|null} props.detail selected detail row
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {string|null} [props.providerName]
 */
export default function RequestDetailDrawer({ detail, isOpen, onClose, providerName }) {
  if (!detail)
    return <Drawer isOpen={isOpen} onClose={onClose} title="Request detail" width="lg" />;
  const ok = !detail.status || detail.status === "ok" || detail.status === "success";
  const tokens = detail.tokens || {};
  const cached = getCached(tokens);
  const cacheWrite = getCacheWrite(tokens);
  const input = getInput(tokens);
  const output = getOutput(tokens);
  const fullRequest = detail.request && !isRedacted(detail.request) ? detail.request : null;
  const curl = fullRequest
    ? buildCurl({
        method: fullRequest.method || "POST",
        url: fullRequest.url || "",
        headers: fullRequest.headers || {},
        body: fullRequest.body ?? fullRequest.data,
      })
    : null;

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title="Request detail" width="lg">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <StatusPill variant={ok ? "ok" : "err"}>{detail.status || "ok"}</StatusPill>
          <span className="min-w-0 truncate font-mono text-sm font-medium">{detail.model}</span>
        </div>
        <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
          {detail.combo ? (
            <div>
              <dt className="text-xs text-muted">Route</dt>
              <dd>
                {detail.combo}
                {detail.step != null ? ` · #${detail.step} ${detail.stepRole || ""}`.trimEnd() : ""}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs text-muted">Latency</dt>
            <dd className="font-mono">
              TTFT {detail.latency?.ttft || 0}ms / Total {detail.latency?.total || 0}ms
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">In / cached / cache-write / out</dt>
            <dd className="font-mono">
              {input.toLocaleString()} / {cached.toLocaleString()} / {cacheWrite.toLocaleString()} /{" "}
              {output.toLocaleString()}
            </dd>
          </div>
          {typeof detail.savedTokens === "number" && detail.savedTokens > 0 ? (
            <div>
              <dt className="text-xs text-muted">Token saver</dt>
              <dd className="font-mono text-lime-ink">−{detail.savedTokens.toLocaleString()}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs text-muted">Provider</dt>
            <dd className="flex items-center gap-2">
              {detail.provider && <ProviderTile providerId={detail.provider} size="sm" />}
              {providerName || detail.provider}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Timestamp</dt>
            <dd>{detail.timestamp ? new Date(detail.timestamp).toLocaleString() : "—"}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">ID</dt>
            <dd className="break-all font-mono text-[13px]">{detail.id}</dd>
          </div>
        </dl>

        {detail.pxpipe ? (
          <section aria-label="PXPIPE" className="rounded-xl border border-line bg-raised p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-semibold">PXPIPE</span>
              <StatusPill variant={detail.pxpipe.applied ? "ok" : "warn"} size="sm">
                {detail.pxpipe.applied ? "Activated" : "Skipped"}
              </StatusPill>
            </div>
            {detail.pxpipe.applied ? (
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="block text-xs text-muted">Original (est.)</dt>
                  <dd className="font-mono">
                    {(detail.pxpipe.tokensBeforeEst || 0).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="block text-xs text-muted">Compressed (est.)</dt>
                  <dd className="font-mono">
                    {(detail.pxpipe.tokensAfterEst || 0).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="block text-xs text-muted">Saved</dt>
                  <dd className="font-mono text-lime-ink">{detail.pxpipe.savedPct || 0}%</dd>
                </div>
                <div>
                  <dt className="block text-xs text-muted">Images</dt>
                  <dd className="font-mono">
                    {detail.pxpipe.imageCount || 0} ({detail.pxpipe.durationMs || 0}ms)
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted">
                Reason: <span className="font-mono">{detail.pxpipe.reason}</span>
                {detail.pxpipe.detail ? ` — ${detail.pxpipe.detail}` : ""}
              </p>
            )}
          </section>
        ) : null}

        {SECTIONS.map((s) => {
          const value = detail[s.key];
          const redacted = value === undefined || isRedacted(value);
          const thinking =
            s.key === "response" &&
            value &&
            !redacted &&
            typeof value === "object" &&
            value.thinking
              ? value.thinking
              : null;
          const content =
            s.key === "response" &&
            value &&
            !redacted &&
            typeof value === "object" &&
            "content" in value
              ? value.content
              : value;
          return (
            <Collapsible
              key={s.key}
              title={s.title}
              open={s.key === "request" || s.key === "response"}
              resetKey={detail.id}
            >
              {redacted ? (
                <EmptyState
                  icon="lock"
                  title="Redacted by server"
                  body="Payloads are redacted by the server; only metadata is shown."
                />
              ) : (
                <>
                  {thinking ? (
                    <div className="mb-3">
                      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-warn">
                        Thinking
                      </h4>
                      <pre className="max-h-48 overflow-auto rounded-lg border border-warn/30 bg-warn-bg p-3 font-mono text-xs">
                        {String(thinking)}
                      </pre>
                    </div>
                  ) : null}
                  <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-raised p-3 font-mono text-xs">
                    {typeof content === "object"
                      ? JSON.stringify(content, null, 2)
                      : String(content ?? "[No content]")}
                  </pre>
                </>
              )}
            </Collapsible>
          );
        })}

        {curl ? (
          <CopyField value="Copy as cURL" copyValue={curl} label="Copy as cURL" />
        ) : (
          <p className="text-sm text-muted">
            Copy as cURL is unavailable: the server redacts request payloads.
          </p>
        )}
        {/* No Replay button: there is no safe replay mechanism. */}
      </div>
    </Drawer>
  );
}

RequestDetailDrawer.propTypes = {
  detail: PropTypes.object,
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
  providerName: PropTypes.string,
};
