"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  Callout,
  Drawer,
  EmptyState,
  Kbd,
  SegmentedControl,
  CardSkeleton,
  EditConnectionModal,
} from "@/shared/components";
import Menu, { MenuItem } from "@/shared/components/Menu";
import { useNotificationStore } from "@/store/notificationStore";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { getModelsByProviderId } from "@/shared/constants/models";
import {
  LIST_FILTERS,
  PROVIDER_LIST_FILTERS,
  getProviderStats,
  matchesProviderListFilter,
  buildProviderListFilterCounts,
  needsAttention as entryNeedsAttention,
  needsLookLabel,
  readSelectedProvider,
  writeSelectedProvider,
} from "./utils";
import { PROVIDER_SECTIONS } from "./sections";
import ProviderCard from "./components/ProviderCard";
import NeedsAttentionCard from "./components/NeedsAttentionCard";
import AddCompatibleModal from "./components/AddCompatibleModal";
import ProviderDetailSidePanel from "./components/ProviderDetailSidePanel";
import AddAccountDialog from "./components/AddAccountDialog";
import TestResultsModal from "./components/TestResultsModal";
import useProviderListData from "./useProviderListData";
import { repairTarget } from "./repairAction";

const APIKEY_INITIAL_VISIBLE = 20;

function useIsNarrow(query = "(max-width: 1279px)") {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [query]);
  return narrow;
}

function entryConnections(entry, connections) {
  return connections.filter((c) => c.provider === entry.id && entry.authTypes.includes(c.authType));
}

function ProvidersListShell({ initialProviderId = null }) {
  const {
    connections,
    setConnections,
    providerNodes,
    setProviderNodes,
    loading,
    fetchError,
    refreshData,
  } = useProviderListData();
  const [filter, setFilter] = useState(LIST_FILTERS.ALL);
  const [searchInput, setSearchInput] = useState("");
  const [showAllApikey, setShowAllApikey] = useState(false);
  const [showAddCompatibleModal, setShowAddCompatibleModal] = useState(false);
  const [showAddAnthropicCompatibleModal, setShowAddAnthropicCompatibleModal] = useState(false);
  const [testingMode, setTestingMode] = useState(null);
  const [testResults, setTestResults] = useState(null);
  const [isTestModalOpen, setIsTestModalOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState(initialProviderId);
  const [addAccountEntry, setAddAccountEntry] = useState(null);
  const [addConnectionError, setAddConnectionError] = useState("");
  const [proxyPools, setProxyPools] = useState([]);
  const [testAccountsMode, setTestAccountsMode] = useState(null);
  const [repairConnection, setRepairConnection] = useState(null);

  const narrowPanel = useIsNarrow();
  const notify = useNotificationStore();
  const headerQuery = useHeaderSearchStore((s) => s.query);
  const headerVisible = useHeaderSearchStore((s) => s.visible);
  const registerSearch = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);
  const setHeaderQuery = useHeaderSearchStore((s) => s.setQuery);

  const router = useRouter();
  const searchParams = useSearchParams();
  const searchInputRef = useRef(null);

  useEffect(() => {
    registerSearch("Search providers...");
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      )
        return;
      event.preventDefault();
      const headerInput = document.querySelector('input[type="search"]');
      if (headerInput) headerInput.focus();
      else searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true")
      .then((res) => (res.ok ? res.json() : { proxyPools: [] }))
      .then((data) => {
        if (!cancelled) setProxyPools(data.proxyPools || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const statsFor = useCallback(
    (providerId, authType) => getProviderStats(connections, providerId, authType),
    [connections],
  );

  const sections = PROVIDER_SECTIONS({ connections, providerNodes, statsFor });
  const allEntries = sections.flatMap((s) => s.entries);
  const selectedEntry = allEntries.find((e) => e.id === selectedProvider) || null;
  const selectedEntryConnections = selectedEntry
    ? entryConnections(selectedEntry, connections)
    : [];

  const query = (headerVisible ? headerQuery : searchInput).trim().toLowerCase();
  const matchSearch = (name) => !query || (name || "").toLowerCase().includes(query);

  const filterEntriesForCounts = allEntries.map((entry) => ({
    stats: entry.stats,
    isNoAuth: entry.isNoAuth,
    authGroup: entry.authGroup,
  }));
  const filterCounts = buildProviderListFilterCounts(filterEntriesForCounts);

  const visibleSections = sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter(
        (entry) =>
          matchSearch(entry.info.name) &&
          matchesProviderListFilter(filter, entry.stats, entry.isNoAuth, entry.authGroup),
      ),
    }))
    .filter((section) => section.entries.length > 0 || section.id === "custom");

  const needsAttention = allEntries
    .filter((entry) => entryNeedsAttention(entry.stats, entry.isNoAuth))
    .slice(0, 6);

  const connectedTotal = filterCounts[LIST_FILTERS.CONNECTED];
  const availableTotal = sections.reduce((sum, s) => sum + s.totalCount, 0);
  const attentionTotal = filterCounts[LIST_FILTERS.NEEDS_ATTENTION];
  const noAuthReadyTotal = allEntries.filter((entry) => entry.isNoAuth).length;
  const isApikeySearching = !!query || filter !== LIST_FILTERS.ALL;

  // Keep panel selection in sync with the URL on Back/Forward.
  const searchParamsString = searchParams?.toString() ?? "";
  useEffect(() => {
    setSelectedProvider(readSelectedProvider(searchParamsString));
  }, [searchParamsString]);

  const openProvider = useCallback(
    (entry) => {
      setSelectedProvider(entry.id);
      router.push(writeSelectedProvider(searchParams?.toString(), entry.id), { scroll: false });
    },
    [router, searchParams],
  );

  const closeProvider = useCallback(() => {
    setSelectedProvider(null);
    router.push(writeSelectedProvider(searchParams?.toString(), null), { scroll: false });
  }, [router, searchParams]);

  const handleToggleProvider = async (providerId, authType, newActive) => {
    const authTypes = Array.isArray(authType) ? authType : [authType];
    const matches = (c) => c.provider === providerId && authTypes.includes(c.authType);
    const providerConns = connections.filter(matches);
    const previous = connections;
    setConnections((prev) => prev.map((c) => (matches(c) ? { ...c, isActive: newActive } : c)));
    const outcomes = await Promise.allSettled(
      providerConns.map((c) =>
        fetch(`/api/providers/${c.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: newActive }),
        }),
      ),
    );
    if (outcomes.some((o) => o.status === "rejected")) {
      setConnections(previous);
      notify.error("Failed to update provider. Please try again.");
    }
  };

  const handleBatchTest = async (mode, providerId = null) => {
    if (testingMode) return;
    setTestingMode(mode === "provider" ? providerId : mode);
    setTestResults(null);
    try {
      const res = await fetch("/api/providers/test-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, providerId }),
      });
      const data = await res.json();
      setTestResults(data);
      setIsTestModalOpen(true);
      if (data.summary) {
        const { passed, failed, total } = data.summary;
        if (failed === 0) notify.success(`All ${total} tests passed`);
        else notify.warning(`${passed}/${total} passed, ${failed} failed`);
      }
      refreshData();
    } catch {
      setTestResults({ error: "Test request failed" });
      setIsTestModalOpen(true);
      notify.error("Provider test failed");
    } finally {
      setTestingMode(null);
    }
  };

  const handleTestAccounts = async (entry) => {
    if (testAccountsMode) return;
    setTestAccountsMode(entry.id);
    try {
      await fetch("/api/providers/test-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "provider", providerId: entry.id }),
      });
      refreshData();
    } catch {
      notify.error("Account test failed");
    } finally {
      setTestAccountsMode(null);
    }
  };

  const handleSaveApiKey = async (formData) => {
    if (!addAccountEntry) return;
    setAddConnectionError("");
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: addAccountEntry.id, ...formData }),
      });
      if (res.ok) {
        setAddAccountEntry(null);
        refreshData();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setAddConnectionError(data?.error || "Failed to save connection");
    } catch {
      setAddConnectionError("Failed to save connection");
    }
  };

  const handleRepairConnection = async (formData) => {
    if (!repairConnection) return "Nothing to repair";
    try {
      const res = await fetch(`/api/providers/${repairConnection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      if (res.ok) {
        setRepairConnection(null);
        refreshData();
        notify.success("Connection updated. Test it to confirm.");
        return null;
      }
      const data = await res.json().catch(() => ({}));
      return data.error || "Failed to save connection";
    } catch {
      return "Failed to save connection";
    }
  };

  const modelCountFor = (entry) =>
    entry.authGroup === "compatible"
      ? null
      : getModelsByProviderId(entry.id).filter((m) => (m.kind || m.type || "llm") === "llm").length;

  if (loading) {
    return (
      <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const hasResults = visibleSections.some((s) => s.entries.length > 0);

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <p className="text-sm text-muted" aria-live="polite">
          {availableTotal} available · {connectedTotal} connected
          {noAuthReadyTotal > 0 && ` · ${noAuthReadyTotal} ready`} ·{" "}
          {needsLookLabel(attentionTotal)}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            size="sm"
            variant="secondary"
            icon="play_arrow"
            loading={testingMode === "all"}
            disabled={!!testingMode}
            onClick={() => handleBatchTest("all")}
            title="Test all connections"
          >
            {testingMode === "all" ? "Testing…" : "Test all"}
          </Button>
          <Menu
            trigger={
              <Button size="sm" variant="primary" icon="add">
                Add provider
              </Button>
            }
          >
            <MenuItem
              icon="add"
              label="Add OpenAI compatible"
              onSelect={() => setShowAddCompatibleModal(true)}
            >
              Add OpenAI compatible
            </MenuItem>
            <MenuItem
              icon="add"
              label="Add Anthropic compatible"
              onSelect={() => setShowAddAnthropicCompatibleModal(true)}
            >
              Add Anthropic compatible
            </MenuItem>
          </Menu>
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SegmentedControl
          aria-label="Filter providers"
          value={filter}
          onChange={setFilter}
          options={PROVIDER_LIST_FILTERS.map((option) => ({
            ...option,
            count: filterCounts[option.value] ?? 0,
          }))}
        />
        {!headerVisible && (
          <label className="flex h-10 items-center gap-2 rounded-xl border border-line bg-raised px-3 text-sm text-muted lg:ms-auto lg:w-[280px]">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              search
            </span>
            <input
              ref={searchInputRef}
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search providers"
              aria-label="Search providers"
              className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-subtle"
            />
            <Kbd>/</Kbd>
          </label>
        )}
        {headerVisible && (
          <span className="hidden items-center gap-1.5 text-xs text-muted lg:ms-auto lg:flex">
            Press <Kbd>/</Kbd> to search
          </span>
        )}
      </div>

      {fetchError && (
        <Callout variant="err" title="Could not load providers">
          <span className="flex flex-wrap items-center gap-2">
            {fetchError}
            <Button size="sm" variant="secondary" onClick={refreshData}>
              Retry
            </Button>
          </span>
        </Callout>
      )}

      {needsAttention.length > 0 && (
        <section aria-label="Needs attention" className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {needsAttention.map((entry) => (
            <NeedsAttentionCard
              key={entry.id}
              entry={entry}
              connections={entryConnections(entry, connections)}
              testing={testingMode === entry.id}
              onRetry={() => handleBatchTest("provider", entry.id)}
              onRepair={(connection) => {
                const target = repairTarget(connection);
                if (target === "reauthorize") {
                  setAddConnectionError("");
                  setAddAccountEntry(entry);
                } else if (target === "edit") {
                  setRepairConnection(connection);
                } else {
                  openProvider(entry);
                }
              }}
              onCooldownExpired={refreshData}
              onOpen={() => openProvider(entry)}
            />
          ))}
        </section>
      )}
      {!hasResults ? (
        <EmptyState
          icon="search_off"
          title="No providers match your search or filters"
          body="Try a different search term or filter."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setFilter(LIST_FILTERS.ALL);
                setSearchInput("");
                setHeaderQuery("");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-6 xl:flex-row xl:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            {visibleSections.map((section) => (
              <ProviderSection
                key={section.id}
                section={section}
                connections={connections}
                showAllApikey={showAllApikey}
                setShowAllApikey={setShowAllApikey}
                isApikeySearching={isApikeySearching}
                testingMode={testingMode}
                selectedProvider={selectedProvider}
                modelCountFor={modelCountFor}
                openProvider={openProvider}
                handleToggleProvider={handleToggleProvider}
                handleBatchTest={handleBatchTest}
                setShowAddCompatibleModal={setShowAddCompatibleModal}
                setShowAddAnthropicCompatibleModal={setShowAddAnthropicCompatibleModal}
              />
            ))}
            <BringYourOwnCard
              onAddOpenAI={() => setShowAddCompatibleModal(true)}
              onAddAnthropic={() => setShowAddAnthropicCompatibleModal(true)}
            />
          </div>

          {selectedEntry && !narrowPanel && (
            <ProviderDetailSidePanel
              entry={selectedEntry}
              connections={selectedEntryConnections}
              onClose={closeProvider}
              onChanged={refreshData}
              onTestAccounts={() => handleTestAccounts(selectedEntry)}
              onAddAccount={() => {
                setAddConnectionError("");
                setAddAccountEntry(selectedEntry);
              }}
              testingAccounts={testAccountsMode === selectedEntry.id}
              inline
            />
          )}
        </div>
      )}

      {selectedEntry && narrowPanel && (
        <Drawer
          isOpen
          onClose={closeProvider}
          title={selectedEntry.info.name}
          size="lg"
          aria-label={`${selectedEntry.info.name} details`}
        >
          <ProviderDetailSidePanel
            entry={selectedEntry}
            connections={selectedEntryConnections}
            onClose={closeProvider}
            onChanged={refreshData}
            onTestAccounts={() => handleTestAccounts(selectedEntry)}
            onAddAccount={() => {
              setAddConnectionError("");
              setAddAccountEntry(selectedEntry);
            }}
            testingAccounts={testAccountsMode === selectedEntry.id}
          />
        </Drawer>
      )}

      <AddCompatibleModal
        variant="openai"
        isOpen={showAddCompatibleModal}
        onClose={() => setShowAddCompatibleModal(false)}
        onCreated={(node) => {
          setProviderNodes((prev) => [...prev, node]);
          setShowAddCompatibleModal(false);
          refreshData();
        }}
      />
      <AddCompatibleModal
        variant="anthropic"
        isOpen={showAddAnthropicCompatibleModal}
        onClose={() => setShowAddAnthropicCompatibleModal(false)}
        onCreated={(node) => {
          setProviderNodes((prev) => [...prev, node]);
          setShowAddAnthropicCompatibleModal(false);
          refreshData();
        }}
      />

      {addAccountEntry && (
        <AddAccountDialog
          entry={addAccountEntry}
          proxyPools={proxyPools}
          error={addConnectionError}
          existingNames={connections.map((c) => c.name).filter(Boolean)}
          onSave={handleSaveApiKey}
          onClose={() => {
            setAddConnectionError("");
            setAddAccountEntry(null);
          }}
          onChanged={refreshData}
        />
      )}

      <EditConnectionModal
        isOpen={Boolean(repairConnection)}
        connection={repairConnection}
        proxyPools={proxyPools}
        onSave={handleRepairConnection}
        onClose={() => setRepairConnection(null)}
      />

      <TestResultsModal
        isOpen={isTestModalOpen}
        onClose={() => setIsTestModalOpen(false)}
        results={testResults}
      />
    </div>
  );
}

ProvidersListShell.propTypes = {
  initialProviderId: PropTypes.string,
};

function ProviderSection({
  section,
  connections,
  showAllApikey,
  setShowAllApikey,
  isApikeySearching,
  testingMode,
  selectedProvider,
  modelCountFor,
  openProvider,
  handleToggleProvider,
  handleBatchTest,
  setShowAddCompatibleModal,
  setShowAddAnthropicCompatibleModal,
}) {
  const entries =
    section.id === "apikey" && !showAllApikey && !isApikeySearching
      ? section.entries.slice(0, APIKEY_INITIAL_VISIBLE)
      : section.entries;

  return (
    <section aria-labelledby={`providers-${section.id}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          id={`providers-${section.id}`}
          className="font-display text-xl font-bold lg:text-[22px]"
        >
          {section.title}
        </h2>
        <span className="text-[13px] text-muted">{section.subtitle}</span>
        {section.id === "apikey" && section.totalCount > APIKEY_INITIAL_VISIBLE && (
          <button
            type="button"
            onClick={() => setShowAllApikey((v) => !v)}
            aria-expanded={showAllApikey || isApikeySearching}
            className="ms-auto text-[13px] font-semibold text-coral-ink hover:text-coral focus-visible:outline-none focus-visible:shadow-focus"
          >
            {showAllApikey || isApikeySearching ? "Show less" : `Show all ${section.totalCount} →`}
          </button>
        )}
        {section.id !== "apikey" && section.id !== "custom" && (
          <Button
            size="sm"
            variant="ghost"
            icon="play_arrow"
            loading={testingMode === section.testMode}
            disabled={!!testingMode}
            onClick={() => handleBatchTest(section.testMode)}
            aria-label={`Test all ${section.title} connections`}
            className="ms-auto"
          >
            {testingMode === section.testMode ? "Testing…" : "Test all"}
          </Button>
        )}
      </div>

      {section.id === "custom" ? (
        <CustomProvidersBlock
          entries={section.entries}
          connections={connections}
          selectedProvider={selectedProvider}
          modelCountFor={modelCountFor}
          openProvider={openProvider}
          handleToggleProvider={handleToggleProvider}
          onAddOpenAI={() => setShowAddCompatibleModal(true)}
          onAddAnthropic={() => setShowAddAnthropicCompatibleModal(true)}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {entries.map((entry) => (
            <ProviderCard
              key={entry.id}
              entry={entry}
              connections={entryConnections(entry, connections)}
              selected={selectedProvider === entry.id}
              modelCount={modelCountFor(entry)}
              onSelect={() => openProvider(entry)}
              onToggle={(active) => handleToggleProvider(entry.id, entry.authTypes, active)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

ProviderSection.propTypes = {
  section: PropTypes.object.isRequired,
  connections: PropTypes.array.isRequired,
  showAllApikey: PropTypes.bool.isRequired,
  setShowAllApikey: PropTypes.func.isRequired,
  isApikeySearching: PropTypes.bool.isRequired,
  testingMode: PropTypes.string,
  selectedProvider: PropTypes.string,
  modelCountFor: PropTypes.func.isRequired,
  openProvider: PropTypes.func.isRequired,
  handleToggleProvider: PropTypes.func.isRequired,
  handleBatchTest: PropTypes.func.isRequired,
  setShowAddCompatibleModal: PropTypes.func.isRequired,
  setShowAddAnthropicCompatibleModal: PropTypes.func.isRequired,
};

function CustomProvidersBlock({
  entries,
  connections,
  selectedProvider,
  modelCountFor,
  openProvider,
  handleToggleProvider,
  onAddOpenAI,
  onAddAnthropic,
}) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line px-4 py-4 text-sm text-muted sm:flex-row sm:items-center">
        <span className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            extension
          </span>
          <span>No custom providers — add OpenAI/Anthropic compatible endpoints</span>
        </span>
        <span className="flex gap-2 sm:ms-auto">
          <Button size="sm" variant="secondary" onClick={onAddAnthropic}>
            Add Anthropic
          </Button>
          <Button size="sm" variant="secondary" onClick={onAddOpenAI}>
            Add OpenAI
          </Button>
        </span>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
      {entries.map((entry) => (
        <ProviderCard
          key={entry.id}
          entry={entry}
          connections={entryConnections(entry, connections)}
          selected={selectedProvider === entry.id}
          modelCount={modelCountFor(entry)}
          onSelect={() => openProvider(entry)}
          onToggle={(active) => handleToggleProvider(entry.id, entry.authTypes, active)}
        />
      ))}
    </div>
  );
}

CustomProvidersBlock.propTypes = {
  entries: PropTypes.array.isRequired,
  connections: PropTypes.array.isRequired,
  selectedProvider: PropTypes.string,
  modelCountFor: PropTypes.func.isRequired,
  openProvider: PropTypes.func.isRequired,
  handleToggleProvider: PropTypes.func.isRequired,
  onAddOpenAI: PropTypes.func.isRequired,
  onAddAnthropic: PropTypes.func.isRequired,
};

function BringYourOwnCard({ onAddOpenAI, onAddAnthropic }) {
  return (
    <section
      aria-label="Bring your own endpoint"
      className="flex flex-col gap-3 rounded-2xl border border-dashed border-line p-4 sm:flex-row sm:items-center sm:gap-3.5 sm:px-4.5"
    >
      <span className="material-symbols-outlined text-[22px] text-muted" aria-hidden="true">
        code
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold">Bring your own endpoint</span>
        <span className="text-[13px] text-muted">
          Any OpenAI- or Anthropic-compatible base URL becomes a provider.
        </span>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="sm" variant="secondary" onClick={onAddOpenAI}>
          + OpenAI compatible
        </Button>
        <Button size="sm" variant="secondary" onClick={onAddAnthropic}>
          + Anthropic compatible
        </Button>
      </div>
    </section>
  );
}

BringYourOwnCard.propTypes = {
  onAddOpenAI: PropTypes.func.isRequired,
  onAddAnthropic: PropTypes.func.isRequired,
};

export default ProvidersListShell;
