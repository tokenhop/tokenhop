"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Select from "./Select";
import Checkbox from "./Checkbox";
import Callout from "./Callout";
import EmptyState from "./EmptyState";
import Button from "./Button";
import { LoadingState } from "./StateViews";

const REGISTRY_ENDPOINT = "/api/cli-tools/cowork-mcp-registry";
const TOOLS_ENDPOINT = "/api/cli-tools/cowork-mcp-tools";

export default function McpMarketplaceModal({ isOpen, onClose, onAdd, addedNames = [] }) {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(null);
  const [expandedUrl, setExpandedUrl] = useState(null);
  const [toolsCache, setToolsCache] = useState({});
  const [toolsLoading, setToolsLoading] = useState({});
  const [toolSelection, setToolSelection] = useState({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: registry is fetched once while open by design
  useEffect(() => {
    if (!isOpen) return;
    if (servers.length > 0) return;
    setLoading(true);
    fetch(REGISTRY_ENDPOINT)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setServers(d.servers || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [isOpen]);

  const addedSet = useMemo(() => new Set(addedNames), [addedNames]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return servers.filter((s) => {
      if (filter === "authless" && s.oauth) return false;
      if (filter === "oauth" && !s.oauth) return false;
      if (!q) return true;
      return (
        (s.title || "").toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q) ||
        (s.name || "").toLowerCase().includes(q)
      );
    });
  }, [servers, search, filter]);

  const fetchTools = async (server) => {
    if (toolsCache[server.url]) return;
    setToolsLoading((p) => ({ ...p, [server.url]: true }));
    try {
      const r = await fetch(TOOLS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: server.url }),
      });
      const d = await r.json();
      const tools = d.tools || [];
      const fallback = Array.isArray(server.toolNames) ? server.toolNames : [];
      const toolNames = tools.length > 0 ? tools.map((t) => t.name) : fallback;
      setToolsCache((p) => ({
        ...p,
        [server.url]: { tools, requiresAuth: !!d.requiresAuth, error: d.error },
      }));
      // Default: all checked
      setToolSelection((p) => ({
        ...p,
        [server.url]: Object.fromEntries(toolNames.map((t) => [t, true])),
      }));
    } catch (e) {
      setToolsCache((p) => ({ ...p, [server.url]: { tools: [], error: e.message } }));
    } finally {
      setToolsLoading((p) => ({ ...p, [server.url]: false }));
    }
  };

  const expandServer = (server) => {
    if (expandedUrl === server.url) {
      setExpandedUrl(null);
      return;
    }
    setExpandedUrl(server.url);
    fetchTools(server);
  };

  const toggleTool = (url, tool) => {
    setToolSelection((prev) => ({ ...prev, [url]: { ...prev[url], [tool]: !prev[url]?.[tool] } }));
  };

  const setAllTools = (url, value) => {
    const sel = toolSelection[url] || {};
    setToolSelection((prev) => ({
      ...prev,
      [url]: Object.fromEntries(Object.keys(sel).map((t) => [t, value])),
    }));
  };

  const confirmAdd = (server) => {
    const sel = toolSelection[server.url] || {};
    const enabled = Object.keys(sel).filter((t) => sel[t]);
    onAdd?.({
      name: server.slug || server.name,
      title: server.title,
      description: server.description,
      url: server.url,
      transport: server.transport,
      oauth: server.oauth,
      toolNames: enabled,
    });
    setExpandedUrl(null);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Browse MCP Marketplace" size="lg">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <label className="sr-only" htmlFor="mcp-search">
              Search servers
            </label>
            <input
              id="mcp-search"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or description..."
              className="w-full rounded border border-line bg-raised px-2 py-1.5 text-xs text-text placeholder:text-subtle focus:border-coral focus:shadow-focus focus:outline-none"
            />
          </div>
          <div className="w-32 shrink-0">
            <Select
              aria-label="Filter by auth type"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              options={[
                { value: "all", label: "All" },
                { value: "authless", label: "Authless" },
                { value: "oauth", label: "OAuth" },
              ]}
              className="[&>div>div>select]:h-8 [&>div>div>select]:py-0 [&>div>div>select]:text-xs"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded bg-err-bg px-2 py-1.5 text-xs text-err">
            {error}
          </p>
        )}

        {loading && <LoadingState lines={3} label="Loading registry" className="py-2" />}

        {!loading && (
          <div className="flex flex-col gap-1 max-h-[60vh] overflow-y-auto">
            {filtered.length === 0 && (
              <EmptyState icon="search_off" title="No servers match filter" className="py-6" />
            )}
            {filtered.map((s) => {
              const added = addedSet.has(s.slug || s.name);
              const expanded = expandedUrl === s.url;
              const cache = toolsCache[s.url];
              const isLoadingTools = toolsLoading[s.url];
              const sel = toolSelection[s.url] || {};
              const toolKeys = Object.keys(sel);
              const selectedCount = Object.values(sel).filter(Boolean).length;
              return (
                <div key={s.url} className="rounded border border-transparent hover:border-line">
                  <div className="flex items-start gap-2 px-2 py-2 hover:bg-raised">
                    {s.iconUrl ? (
                      // biome-ignore lint/performance/noImgElement: raw img with onError fallback for dynamic icons
                      <img
                        src={s.iconUrl}
                        alt=""
                        className="size-7 rounded shrink-0 object-contain"
                        onError={(e) => {
                          e.target.style.display = "none";
                        }}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="size-7 shrink-0 rounded bg-raised" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium text-xs">{s.title}</span>
                        {s.oauth ? (
                          <span className="px-1 py-0.5 text-[9px] rounded bg-amber-500/10 text-amber-600">
                            OAuth
                          </span>
                        ) : (
                          <span className="px-1 py-0.5 text-[9px] rounded bg-green-500/10 text-green-600">
                            Authless
                          </span>
                        )}
                        {s.toolCount > 0 && (
                          <span className="text-[10px] text-muted">{s.toolCount} tools</span>
                        )}
                      </div>
                      {s.description && (
                        <p className="mt-0.5 line-clamp-2 text-[10px] text-muted">
                          {s.description}
                        </p>
                      )}
                    </div>
                    <Button
                      onClick={() => (added ? null : expandServer(s))}
                      disabled={added}
                      size="sm"
                      variant={added ? "success" : expanded ? "secondary" : "ghost"}
                      className={added ? "cursor-default" : ""}
                    >
                      {added ? "Added" : expanded ? "Cancel" : "+ Add"}
                    </Button>
                  </div>
                  {expanded && (
                    <div className="flex flex-col gap-2 border-t border-line bg-raised/40 px-3 py-2">
                      {isLoadingTools && (
                        <LoadingState lines={1} label="Probing server for tools" />
                      )}
                      {!isLoadingTools && cache?.requiresAuth && (
                        <Callout variant="warn" className="p-2 text-[10px]">
                          OAuth required. Add now and authenticate after Apply; the tool list will
                          be discovered after the first connect.
                        </Callout>
                      )}
                      {!isLoadingTools && cache?.error && !cache?.requiresAuth && (
                        <Callout variant="err" className="p-2 text-[10px]">
                          Probe failed: {cache.error}
                        </Callout>
                      )}
                      {!isLoadingTools &&
                        toolKeys.length === 0 &&
                        !cache?.requiresAuth &&
                        !cache?.error && (
                          <p className="text-[10px] text-muted">No tools advertised by server.</p>
                        )}
                      {!isLoadingTools && toolKeys.length > 0 && (
                        <>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-muted">
                              {selectedCount}/{toolKeys.length} tools enabled
                            </span>
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => setAllTools(s.url, true)}
                                className="text-[10px] text-coral hover:underline"
                              >
                                All
                              </button>
                              <span className="text-[10px] text-muted" aria-hidden="true">
                                ·
                              </span>
                              <button
                                type="button"
                                onClick={() => setAllTools(s.url, false)}
                                className="text-[10px] text-coral hover:underline"
                              >
                                None
                              </button>
                            </div>
                          </div>
                          <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto">
                            {toolKeys.map((t) => (
                              <Checkbox
                                key={t}
                                checked={!!sel[t]}
                                onChange={() => toggleTool(s.url, t)}
                                label={
                                  <span className="block max-w-full truncate text-[10px]" title={t}>
                                    {t}
                                  </span>
                                }
                                className="gap-1 [&>span:first-child]:size-6 [&>span:first-child]:-ms-0 [&>span:first-child>span]:size-3.5 [&>span:first-child>span>span]:text-[10px] [&>label]:pt-0"
                              />
                            ))}
                          </div>
                        </>
                      )}
                      <Button
                        size="sm"
                        icon="check"
                        onClick={() => confirmAdd(s)}
                        className="self-end"
                      >
                        Confirm add
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="text-end text-[10px] text-muted">
          {filtered.length} of {servers.length} servers
        </div>
      </div>
    </Modal>
  );
}

McpMarketplaceModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onAdd: PropTypes.func,
  addedNames: PropTypes.arrayOf(PropTypes.string),
};
