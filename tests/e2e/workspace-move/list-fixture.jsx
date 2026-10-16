import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import Card from "@/shared/components/Card";
import PageTitle from "@/shared/components/PageTitle";
import MoveToWorkspaceButton from "@/shared/components/MoveToWorkspaceButton";
import SortableComboCard from "@/shared/components/combos/SortableComboCard";
import SortableConnectionRow from "@/app/(dashboard)/dashboard/providers/detail/SortableConnectionRow";
import ApiKeysCard from "@/app/(dashboard)/dashboard/endpoint/components/ApiKeysCard";
import MoveFromDefault from "@/app/(dashboard)/dashboard/providers/components/MoveFromDefault";
import { accountView } from "@/shared/utils/account";
import { status } from "./auth-mock.mjs";

const noop = () => {};
const ENTRIES = ["first", "second", "third"];
const mode = new URLSearchParams(location.search).get("mode") || "delayed";

/** Apply the list refresh in the timing the mode names (see fixture.jsx). */
export function scheduleRefresh(apply) {
  window.fixture.refreshPending = true;
  const run = () => {
    apply();
    window.fixture.refreshed = true;
    window.fixture.refreshPending = false;
    window.fixture.releaseRefresh = null;
  };
  if (mode === "immediate" || mode === "immediate-flush") {
    // syncDelta = commits that happened synchronously inside this call: 0 means
    // React batched the removal with the dialog's own close in the same task.
    window.fixture.beforeImmediate = {
      rowPresent: !!document.querySelector('[data-row="second"]'),
      dialogOpen: !!document.querySelector('[role="dialog"]'),
    };
    const before = window.fixture.commits.length;
    if (mode === "immediate-flush") flushSync(run);
    else run();
    window.fixture.syncDelta = window.fixture.commits.length - before; // measured after the call
    return;
  }
  // Delayed modes wait for the runner to release the gate, proving focus
  // already landed before any refresh can race it.
  window.fixture.releaseRefresh = () => {
    run();
  };
}

export function ListFixture() {
  const target = useRef(null);
  const [rows, setRows] = useState(mode === "last" ? ["second"] : ENTRIES);
  // Runs after every committed render; the portaled dialog is already (un)mounted.
  useLayoutEffect(() => {
    window.fixture.commits.push({
      rows: [...rows],
      dialogOpen: Boolean(document.querySelector('[role="dialog"]')),
    });
  });
  const refresh = (id) =>
    scheduleRefresh(() => setRows((current) => current.filter((row) => row !== id)));
  return (
    <main>
      <Card title="Your combos" headingRef={target} data-testid="list-card">
        {rows.length ? (
          <ul aria-label="Combos">
            {rows.map((id) => (
              <li key={id} data-row={id}>
                <span>{id}</span>
                <MoveToWorkspaceButton
                  label={`Move ${id}`}
                  items={[{ type: "combo", id, label: id }]}
                  successFocusRef={target}
                  onMoved={() => refresh(id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="empty">No combos</p>
        )}
        <button type="button" id="after-list">
          Create combo
        </button>
      </Card>
    </main>
  );
}

export function ComboFixture() {
  const target = useRef(null);
  const [rows, setRows] = useState(ENTRIES);
  const refresh = (id) =>
    scheduleRefresh(() => setRows((current) => current.filter((row) => row !== id)));
  return (
    <main>
      <Card title="Combos" headingRef={target} data-testid="list-card">
        {rows.length ? (
          <DndContext>
            <SortableContext items={rows} strategy={verticalListSortingStrategy}>
              <ul aria-label="Combos">
                {rows.map((id, index) => (
                  <SortableComboCard
                    key={id}
                    combo={{ id, name: id, models: ["a"] }}
                    index={index}
                    total={rows.length}
                    strategyLabel="Fallback"
                    onSelect={noop}
                    successFocusRef={target}
                    onMoved={() => refresh(id)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        ) : (
          <p data-testid="empty">No combos</p>
        )}
        <button type="button" id="after-list">
          Create combo
        </button>
      </Card>
    </main>
  );
}

export function ConnectionFixture() {
  const target = useRef(null);
  const [rows, setRows] = useState(ENTRIES);
  const refresh = (id) =>
    scheduleRefresh(() => setRows((current) => current.filter((row) => row !== id)));
  return (
    <main>
      <Card title="Connections" headingRef={target} data-testid="list-card">
        {rows.length ? (
          <DndContext>
            <SortableContext items={rows} strategy={verticalListSortingStrategy}>
              <ul aria-label="Connections">
                {rows.map((id, index) => (
                  <SortableConnectionRow
                    key={id}
                    connection={{
                      id,
                      name: id,
                      provider: "openai",
                      workspaceId: "ws-personal",
                      isActive: true,
                      authType: "apikey",
                    }}
                    index={index}
                    total={rows.length}
                    showHandle={false}
                    proxyPools={[]}
                    isOAuth={false}
                    showWeighted={false}
                    onSelect={noop}
                    onToggleActive={noop}
                    onUpdateProxy={noop}
                    onEdit={noop}
                    onDelete={noop}
                    onMove={noop}
                    onShared={() => refresh(id)}
                    successFocusRef={target}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        ) : (
          <p data-testid="empty">No connections</p>
        )}
        <button type="button" id="after-list">
          Add connection
        </button>
      </Card>
    </main>
  );
}

export function NodeFixture() {
  const target = useRef(null);
  const [node, setNode] = useState({ id: "node-second", name: "node-second" });
  const refresh = () => scheduleRefresh(() => setNode(null));
  return (
    <main>
      <PageTitle titleRef={target}>Provider detail</PageTitle>
      {node ? (
        <Card
          title="OpenAI Compatible Details"
          data-testid="node-card"
          data-row="node-second"
          action={
            <MoveToWorkspaceButton
              variant="button"
              label="Move"
              items={[{ type: "node", id: node.id, label: node.name }]}
              successFocusRef={target}
              onMoved={refresh}
            />
          }
        />
      ) : (
        <p data-testid="empty">No node</p>
      )}
      <button type="button" id="after-list">
        Save
      </button>
    </main>
  );
}

export function ApiKeysFixture({ branch }) {
  const target = useRef(null);
  const [rows, setRows] = useState([{ id: "key-first" }, { id: "key-second" }]);
  const refresh = (id) =>
    scheduleRefresh(() => setRows((current) => current.filter((row) => row.id !== id)));
  // The real card renders one shared heading; the harness toggles only the
  // responsive branch visibility via viewport, exactly like production CSS.
  return (
    <main>
      <ApiKeysCard
        headingRef={target}
        data-testid="list-card"
        keys={rows.map(({ id }) => ({
          id,
          name: id.replace("key-", ""),
          prefix: `sk-${id}`,
          type: "hashed",
          isActive: true,
        }))}
        requireApiKey
        onToggleRequireApiKey={noop}
        onCreateKey={noop}
        createdBanner={null}
        onDismissBanner={noop}
        onCopy={noop}
        copiedId={null}
        copyError={null}
        visibleIds={new Set()}
        onToggleVisibility={noop}
        togglingId={null}
        onToggleKey={noop}
        deletingId={null}
        onDeleteKey={noop}
        onRenameKey={async () => true}
        renamingId={null}
        renameErrors={{}}
        clearRenameError={noop}
        loading={false}
        hashedMode
        workspaceId="ws-personal"
        onMoved={() => refresh("key-second")}
        data-branch={branch}
      />
      <button type="button" id="after-list">
        Refresh keys
      </button>
    </main>
  );
}

export function BulkFixture() {
  const view = useMemo(() => accountView(status), []);
  const [moved, setMoved] = useState(false);
  return (
    <main>
      <MoveFromDefault
        view={view}
        onMoved={() => {
          setMoved(true);
          window.fixture.refreshed = true;
        }}
      />
      {moved ? <p data-testid="moved">Moved</p> : null}
      <button type="button" id="after-list">
        Refresh providers
      </button>
    </main>
  );
}
