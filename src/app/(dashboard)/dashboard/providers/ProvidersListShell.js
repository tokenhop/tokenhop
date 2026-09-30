"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { refreshShellStatus } from "@/shared/hooks/useShellStatus";
import PropTypes from "prop-types";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  Callout,
  Drawer,
  EmptyState,
  SegmentedControl,
  CardSkeleton,
  EditConnectionModal,
  ToolbarSearch,
} from "@/shared/components";
import Menu, { MenuItem } from "@/shared/components/Menu";
import { getModelsByProviderId } from "@/shared/constants/models";
import {
  LIST_FILTERS,
  PROVIDER_LIST_FILTERS,
  readSelectedProvider,
  writeSelectedProvider,
  needsLookLabel,
} from "./utils";
import NeedsAttentionCard from "./components/NeedsAttentionCard";
import AddCompatibleModal from "./components/AddCompatibleModal";
import ProviderDetailSidePanel from "./components/ProviderDetailSidePanel";
import AddAccountDialog from "./components/AddAccountDialog";
import TestResultsModal from "./components/TestResultsModal";
import YourProviders from "./components/YourProviders";
import CatalogSection from "./components/CatalogSection";
import BringYourOwnCard from "./components/BringYourOwnCard";
import useProviderListData from "./useProviderListData";
import useProviderSections from "./useProviderSections";
import useCollapsedGroups from "./useCollapsedGroups";
import useProviderActions from "./useProviderActions";
import { repairTarget } from "./repairAction";

const EMPTY_CONNECTIONS = [];

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

function ProvidersListShell({ initialProviderId = null }) {
  const {
    connections,
    setConnections,
    providerNodes,
    setProviderNodes,
    loading,
    fetchError,
    refreshData: reloadList,
  } = useProviderListData();
  // Every list reload follows a mutation or retry, so the shell badges refresh with it.
  const refreshData = useCallback(() => {
    reloadList();
    refreshShellStatus();
  }, [reloadList]);
  const [filter, setFilter] = useState(LIST_FILTERS.ALL);
  const [searchInput, setSearchInput] = useState("");
  const [showAllApikey, setShowAllApikey] = useState(false);
  const [showAddCompatibleModal, setShowAddCompatibleModal] = useState(false);
  const [showAddAnthropicCompatibleModal, setShowAddAnthropicCompatibleModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState(initialProviderId);
  const [proxyPools, setProxyPools] = useState([]);

  const narrowPanel = useIsNarrow();
  const router = useRouter();
  const searchParams = useSearchParams();

  const actions = useProviderActions({ connections, setConnections, refreshData });
  const {
    testingMode,
    testResults,
    isTestModalOpen,
    setIsTestModalOpen,
    testAccountsMode,
    addAccountEntry,
    setAddAccountEntry,
    addConnectionError,
    setAddConnectionError,
    repairConnection,
    setRepairConnection,
    handleToggleProvider,
    handleBatchTest,
    handleTestAccounts,
    handleSaveApiKey,
    handleRepairConnection,
  } = actions;

  const { isCollapsed, toggle: toggleGroup } = useCollapsedGroups();

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

  const {
    allEntries,
    yourProviders,
    yourProvidersTotal,
    catalogSections,
    filterCounts,
    needsAttention,
    totals,
    isStale,
  } = useProviderSections({ connections, providerNodes, query: searchInput, filter });

  const connectionMap = useMemo(() => {
    const map = new Map();
    for (const connection of connections) {
      const list = map.get(connection.provider);
      if (list) list.push(connection);
      else map.set(connection.provider, [connection]);
    }
    return map;
  }, [connections]);

  const connectionsFor = useCallback(
    (entry) => connectionMap.get(entry.id) || EMPTY_CONNECTIONS,
    [connectionMap],
  );

  const selectedEntry = allEntries.find((e) => e.id === selectedProvider) || null;
  const selectedEntryConnections = useMemo(
    () => (selectedEntry ? connectionsFor(selectedEntry) : []),
    [selectedEntry, connectionsFor],
  );

  const filterActive = filter !== LIST_FILTERS.ALL;
  const searching = searchInput.trim().length > 0;
  const forceOpen = filterActive || searching;
  const nonCustom = catalogSections.filter((s) => s.id !== "custom");
  const customGroup = catalogSections.find((s) => s.id === "custom");
  const customEntries = customGroup?.entries || [];

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

  const selectProvider = useCallback(
    (entry) => {
      if (entry.id === selectedProvider) closeProvider();
      else openProvider(entry);
    },
    [selectedProvider, closeProvider, openProvider],
  );

  const modelCountFor = useCallback(
    (entry) =>
      entry.authGroup === "compatible"
        ? null
        : getModelsByProviderId(entry.id).filter((m) => (m.kind || m.type || "llm") === "llm")
            .length,
    [],
  );

  const onTestAll = useCallback(() => handleBatchTest("all"), [handleBatchTest]);

  // Stable entry-scoped callbacks for the attention cards, so the memoized
  // NeedsAttentionCard only re-renders when its own props change.
  const retryEntry = useCallback(
    (entry) => handleBatchTest("provider", entry.id),
    [handleBatchTest],
  );
  const repairEntry = useCallback(
    (entry, connection) => {
      const target = repairTarget(connection);
      if (target === "reauthorize") {
        setAddConnectionError("");
        setAddAccountEntry(entry);
      } else if (target === "edit") {
        setRepairConnection(connection);
      } else {
        openProvider(entry);
      }
    },
    [openProvider, setAddConnectionError, setAddAccountEntry, setRepairConnection],
  );

  const onTestAccounts = useCallback((entry) => handleTestAccounts(entry), [handleTestAccounts]);
  const onTestSelected = useCallback(
    () => selectedEntry && handleTestAccounts(selectedEntry),
    [selectedEntry, handleTestAccounts],
  );
  const onAddAccountSelected = useCallback(() => {
    if (!selectedEntry) return;
    setAddConnectionError("");
    setAddAccountEntry(selectedEntry);
  }, [selectedEntry, setAddAccountEntry, setAddConnectionError]);

  const openAddOpenAI = useCallback(() => setShowAddCompatibleModal(true), []);
  const openAddAnthropic = useCallback(() => setShowAddAnthropicCompatibleModal(true), []);
  const onCompatibleCreated = useCallback(
    (node, close) => {
      setProviderNodes((prev) => [...prev, node]);
      close();
      refreshData();
    },
    [setProviderNodes, refreshData],
  );
  const closeAddAccountDialog = useCallback(() => {
    setAddConnectionError("");
    setAddAccountEntry(null);
  }, [setAddAccountEntry, setAddConnectionError]);
  const clearFilters = useCallback(() => {
    setFilter(LIST_FILTERS.ALL);
    setSearchInput("");
  }, []);
  const onSearchChange = useCallback((e) => setSearchInput(e.target.value), []);

  if (loading) {
    return (
      <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const hasResults = yourProviders.length > 0 || catalogSections.some((s) => s.entries.length > 0);

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <p className="text-sm text-muted" aria-live="polite">
          {totals.available} available · {totals.connected} connected
          {totals.noAuthReady > 0 && ` · ${totals.noAuthReady} ready`} ·{" "}
          {needsLookLabel(totals.attention)}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
        <ToolbarSearch
          value={searchInput}
          onChange={onSearchChange}
          placeholder="Search providers"
          ariaLabel="Search providers"
          className="lg:ms-auto lg:w-[280px]"
        />
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
              connections={connectionsFor(entry)}
              testing={testingMode === entry.id}
              onRetry={retryEntry}
              onRepair={repairEntry}
              onCooldownExpired={refreshData}
              onOpen={openProvider}
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
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div
          className="flex min-w-0 flex-col gap-6 xl:flex-row xl:items-start"
          aria-busy={isStale || undefined}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <YourProviders
              entries={yourProviders}
              total={yourProvidersTotal}
              connectionsFor={connectionsFor}
              selectedProvider={selectedProvider}
              testingMode={testingMode ?? undefined}
              testAccountsMode={testAccountsMode ?? undefined}
              onOpen={selectProvider}
              onClose={closeProvider}
              onTest={onTestAccounts}
              onTestAll={onTestAll}
            />
            {(nonCustom.length > 0 || customEntries.length > 0) && (
              <h2
                id="providers-catalog"
                tabIndex={-1}
                className="font-display text-xl font-bold lg:text-[22px]"
              >
                Add more providers
              </h2>
            )}
            {nonCustom.map((section) => (
              <CatalogSection
                key={section.id}
                section={section}
                collapsed={isCollapsed(section.id)}
                onToggleCollapse={toggleGroup}
                connectionsFor={connectionsFor}
                showAllApikey={showAllApikey}
                setShowAllApikey={setShowAllApikey}
                forceOpen={forceOpen}
                selectedProvider={selectedProvider}
                modelCountFor={modelCountFor}
                openProvider={selectProvider}
                handleToggleProvider={handleToggleProvider}
              />
            ))}
            <BringYourOwnCard
              entries={customEntries}
              connectionsFor={connectionsFor}
              selectedProvider={selectedProvider}
              modelCountFor={modelCountFor}
              openProvider={selectProvider}
              handleToggleProvider={handleToggleProvider}
              onAddOpenAI={openAddOpenAI}
              onAddAnthropic={openAddAnthropic}
            />
          </div>

          {selectedEntry && !narrowPanel && (
            <ProviderDetailSidePanel
              entry={selectedEntry}
              connections={selectedEntryConnections}
              onClose={closeProvider}
              onChanged={refreshData}
              onTestAccounts={onTestSelected}
              onAddAccount={onAddAccountSelected}
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
            onTestAccounts={onTestSelected}
            onAddAccount={onAddAccountSelected}
            testingAccounts={testAccountsMode === selectedEntry.id}
          />
        </Drawer>
      )}

      <AddCompatibleModal
        variant="openai"
        isOpen={showAddCompatibleModal}
        onClose={() => setShowAddCompatibleModal(false)}
        onCreated={(node) => onCompatibleCreated(node, () => setShowAddCompatibleModal(false))}
      />
      <AddCompatibleModal
        variant="anthropic"
        isOpen={showAddAnthropicCompatibleModal}
        onClose={() => setShowAddAnthropicCompatibleModal(false)}
        onCreated={(node) =>
          onCompatibleCreated(node, () => setShowAddAnthropicCompatibleModal(false))
        }
      />

      {addAccountEntry && (
        <AddAccountDialog
          entry={addAccountEntry}
          proxyPools={proxyPools}
          error={addConnectionError}
          existingNames={connections.map((c) => c.name).filter(Boolean)}
          onSave={handleSaveApiKey}
          onClose={closeAddAccountDialog}
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

export default ProvidersListShell;
