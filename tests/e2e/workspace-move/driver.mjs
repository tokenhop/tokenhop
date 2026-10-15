import assert from "node:assert/strict";
import { poll } from "./cdp.mjs";

const buttonExpression = (
  label,
  scope = "document",
) => `([...${scope}.querySelectorAll('button')].find(b => {
  const clone = b.cloneNode(true);
  clone.querySelectorAll('[aria-hidden="true"], .material-symbols-outlined').forEach(n => n.remove());
  return b.getClientRects().length && (b.getAttribute('aria-label') === ${JSON.stringify(label)} || clone.textContent.trim() === ${JSON.stringify(label)});
}))`;

/** Focus a visible real button and activate it with a native Enter keystroke. */
export async function activate(cdp, label, dialog = false) {
  const scope = dialog ? `document.querySelector('[role="dialog"]')` : "document";
  await poll(
    () =>
      cdp.evaluate(
        `(() => { const s = ${scope}; if (!s) return false; const b = ${buttonExpression(label, "s")}; if (!b || b.disabled) return false; b.focus(); return document.activeElement === b; })()`,
      ),
    `enabled visible button: ${label}`,
  );
  await cdp.pressEnter();
}

async function checkbox(cdp, label) {
  await poll(
    () =>
      cdp.evaluate(`(() => {
    const l = [...document.querySelectorAll('[role="dialog"] label')].find(l => l.textContent.trim() === ${JSON.stringify(label)});
    const input = l && document.getElementById(l.htmlFor);
    if (!input) return false; input.focus(); return true;
  })()`),
    `checkbox: ${label}`,
  );
  await cdp.key(" ", "Space", 32, " ");
}

export async function snapshot(cdp, trigger) {
  return cdp.evaluate(`(() => {
    const active = document.activeElement;
    const opener = ${buttonExpression(trigger)};

    const dialog = document.querySelector('[role="dialog"]');
    return {
      active: active.tagName + ':' + (active.getAttribute('aria-label') || active.textContent.trim().slice(0, 45)),
      headingFocused: active === window.fixture.headingElement && !!window.fixture.headingElement,
      triggerFocused: !!opener && active === opener,
      dialogOpen: !!dialog, inside: !!dialog && dialog.contains(active),
      rows: [...document.querySelectorAll('[data-row]')].map(n => n.dataset.row),
      movers: [...document.querySelectorAll('button')].filter(b => b.getClientRects().length && /^Move/.test(b.getAttribute('aria-label') || b.textContent.replace(/sync_alt/g, '').trim())).map(b => b.getAttribute('aria-label') || b.textContent.replace(/sync_alt/g, '').trim()),
      empty: !!document.querySelector('[data-testid="empty"], [data-moved="true"]'),
      requests: window.fixture.requests, focusLog: window.fixture.focusLog,
    };
  })()`);
}

/** Desktop vs mobile trigger visibility, proven with the real compiled CSS. */
async function assertBranch(cdp, trigger, branch) {
  const all = await cdp.evaluate(
    `[...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === ${JSON.stringify(trigger)}).length`,
  );
  assert.ok(all >= 2, `Expected duplicate desktop+mobile triggers, got ${all}`);
  const visible =
    await cdp.evaluate(`[...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === ${JSON.stringify(trigger)} && b.getClientRects().length).map(b => {
    const classes = []; for (let n = b; n; n = n.parentElement) classes.push(...n.classList);
    const hiddenMd = classes.includes('md:hidden'); const hiddenBlock = classes.includes('md:block');
    return { hiddenMd, hiddenBlock };
  })`);
  assert.equal(
    visible.length,
    1,
    `Exactly one branch visible at this viewport, got ${JSON.stringify(visible)}`,
  );
  assert.equal(
    visible[0].hiddenMd,
    branch === "mobile",
    `Mobile case must expose the md:hidden trigger`,
  );
  assert.equal(
    visible[0].hiddenBlock,
    branch === "desktop",
    `Desktop case must expose the hidden md:block trigger`,
  );
}

/**
 * Run one declared case through keyboard-only browser interaction.
 * Delayed modes gate the refresh until focus is observed: the assertion can
 * never pass just because the timing race happened to land before the poll.
 */
export async function runCase(cdp, baseUrl, definition) {
  const { mode, trigger, flow } = definition;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: definition.viewport || 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: Boolean(definition.viewport),
  });
  await cdp.send("Page.navigate", { url: `${baseUrl}fixture?mode=${mode}` });
  await poll(() => cdp.evaluate(`window.fixture !== undefined`), "fixture bootstraps");
  if (definition.branch) await assertBranch(cdp, trigger, definition.branch);
  await poll(() => cdp.evaluate(`!!document.querySelector("h1, h2, button")`), "fixture mounts");
  await cdp.evaluate(`window.fixture.headingElement = document.querySelector("h1, h2"); true`);
  await activate(cdp, trigger);
  await poll(() => cdp.evaluate(`!!document.querySelector('[role="dialog"]')`), "dialog opens");
  const initialRows = (await snapshot(cdp, trigger)).rows;
  for (const step of flow) {
    if (step === "check") {
      await activate(cdp, "Check move", true);
      await poll(
        () =>
          cdp.evaluate(
            `window.fixture.requests.length > 0 && !![...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'sync_altMove' || b.textContent.includes('Move and apply changes'))`,
          ),
        "preview settles",
      );
    } else if (step === "confirm") {
      await activate(
        cdp,
        definition.ack || mode === "warning" ? "Move and apply changes" : "Move",
        true,
      );
      await poll(
        () => cdp.evaluate(`window.fixture.requests.some(r => r.confirm)`),
        "confirm recorded",
      );
    } else if (step === "cancel") {
      await activate(cdp, "Cancel", true);
    } else if (step === "escape") {
      await cdp.pressEscape();
    } else if (step === "conflict-assert") {
      await poll(
        () =>
          cdp.evaluate(`document.querySelector('[role="dialog"]')?.textContent.includes('taken')`),
        "conflict visible",
      );
      assert.equal(
        await cdp.evaluate(
          `!![...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'sync_altMove' && b.disabled)`,
        ),
        true,
        "Conflict disables Move",
      );
      assert.equal((await snapshot(cdp, trigger)).inside, true, "Conflict retains focus inside");
    } else if (step === "ack") {
      assert.equal(
        await cdp.evaluate(
          `!![...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.includes('Move and apply changes') && b.disabled)`,
        ),
        true,
        "Warnings require acknowledgement",
      );
      await poll(
        () => cdp.evaluate(`!!document.querySelector('[role="dialog"] input[type="checkbox"]')`),
        "warning checkbox",
      );
      await cdp.evaluate(
        `document.querySelector('[role="dialog"] input[type="checkbox"]').focus()`,
      );
      await cdp.key(" ", "Space", 32, " ");
    } else if (step === "error-assert") {
      await poll(
        () =>
          cdp.evaluate(
            `document.querySelector('[role="dialog"]')?.textContent.includes('Could not move these items')`,
          ),
        "error shown",
      );
      assert.equal((await snapshot(cdp, trigger)).inside, true, "Error retains focus inside");
    } else if (step.startsWith("bulk")) {
      await checkbox(cdp, "Select all");
      await activate(cdp, "Continue with 2", true);
      await poll(
        () =>
          cdp.evaluate(
            `document.querySelector('[role="dialog"]')?.textContent.includes('History stays')`,
          ),
        "bulk review replaces picker",
      );
      assert.equal((await snapshot(cdp, trigger)).inside, true, "Review keeps focus trapped");
      if (step === "bulk-cancel") await activate(cdp, "Cancel", true);
      else if (step === "bulk-escape") await cdp.pressEscape();
      else {
        await activate(cdp, "Check move", true);
        await activate(cdp, "Move", true);
      }
    }
  }
  const isSuccess =
    definition.expectFocusAfter !== "trigger" && definition.expectFocusAfter !== "bulk-trigger";
  if (!isSuccess) {
    await poll(
      () => cdp.evaluate(`!document.querySelector('[role="dialog"]')`),
      "cancel/escape closes",
    );
  } else if (definition.immediate) {
    // The row/trigger is removed in the SAME commit as close (or synchronously
    // before it for immediate-flush). No gated release; commit-order proof below.
    await poll(
      () => cdp.evaluate(`window.fixture.refreshed && !document.querySelector('[role="dialog"]')`),
      "immediate refresh commits",
    );
  } else {
    // Close first, then verify focus lands BEFORE the refresh can run.
    await poll(
      () => cdp.evaluate(`!document.querySelector('[role="dialog"]')`),
      "dialog closes before refresh",
    );
    await poll(() => cdp.evaluate(`!!window.fixture.releaseRefresh`), "refresh is still gated");
    const beforeRefresh = await snapshot(cdp, trigger);
    assert.equal(
      beforeRefresh.headingFocused,
      true,
      `${definition.name}: heading focused after close, BEFORE refresh (got ${beforeRefresh.active})`,
    );
    await cdp.evaluate(`window.fixture.releaseRefresh()`);
    await poll(() => cdp.evaluate(`window.fixture.refreshed`), "refresh completes after release");
    const afterRefresh = await snapshot(cdp, trigger);
    assert.equal(
      afterRefresh.headingFocused,
      true,
      `${definition.name}: heading still focused AFTER refresh settles (got ${afterRefresh.active})`,
    );
  }
  const result = await snapshot(cdp, trigger);
  if (!isSuccess) {
    assert.equal(
      result.triggerFocused,
      true,
      `${definition.name}: opener must regain focus, got ${result.active}`,
    );
    if (definition.rowsUnchanged) assert.deepEqual(result.rows, initialRows);
    assert.ok(
      result.movers.includes(trigger),
      `Cancelled/blocked move keeps its action (${result.movers})`,
    );
  } else {
    assert.equal(
      result.headingFocused,
      true,
      `${definition.name}: stable heading must regain focus, got ${result.active}`,
    );
    assert.ok(
      !result.movers.includes(trigger),
      `${definition.name}: moved item's Move action must be gone (${result.movers})`,
    );
    if (definition.rowGone) assert.ok(!result.rows.includes(definition.rowGone));
    if (definition.empty) assert.equal(result.empty, true);
    if (definition.otherRowsRemain) assert.deepEqual(result.rows, definition.otherRowsRemain);
    if (definition.modelRowRemains)
      assert.equal(
        await cdp.evaluate(
          `!![...document.querySelectorAll("code")].find(n => n.textContent === "prov/second-model")`,
        ),
        true,
        "Catalog model remains after its alias move",
      );
    if (definition.immediate) {
      // Layout-effect commit log from the owner fixture: the row and the open
      // dialog disappear in ONE commit (batched), never one then the other.
      const { commits, syncDelta, before } = await cdp.evaluate(
        `({ commits: window.fixture.commits, syncDelta: window.fixture.syncDelta, before: window.fixture.beforeImmediate })`,
      );
      const gone = commits.findIndex((c) => !c.rows.includes("second"));
      assert.ok(gone > 0, `row removal never committed: ${JSON.stringify(commits)}`);
      assert.deepEqual(
        before,
        { rowPresent: true, dialogOpen: true },
        "Before the immediate update, row and dialog must both be committed",
      );
      assert.deepEqual(
        [commits[gone].dialogOpen, commits[gone].rows.includes("second")],
        [false, false],
        "Removal and dialog close must be ONE commit",
      );
      assert.equal(
        commits.filter((c) => !c.rows.includes("second") && c.dialogOpen).length,
        0,
        "No commit may show row gone with dialog open",
      );
      if (definition.mode === "immediate-flush")
        assert.ok(
          syncDelta >= 1,
          `flushSync must commit synchronously inside onMoved (delta ${syncDelta})`,
        );
      else
        assert.equal(
          syncDelta,
          0,
          `Immediate refresh must be batched with onClose, not committed synchronously (delta ${syncDelta})`,
        );
    }
    assert.equal(
      await cdp.evaluate(`document.activeElement.tabIndex`),
      -1,
      "Heading is not a normal tab stop",
    );
    await cdp.key("Tab", "Tab", 9);
    assert.equal(
      await cdp.evaluate(
        `document.activeElement !== document.body && !document.activeElement.closest('[role="dialog"]')`,
      ),
      true,
      "Next Tab reaches live list action",
    );
  }
  const requests = result.requests;
  const didConfirm = flow.includes("confirm") || flow.includes("bulk-success");
  assert.equal(
    requests.filter((r) => r.confirm).length,
    didConfirm ? 1 : 0,
    "exact confirm request count",
  );
  if (requests.length) {
    const first = requests[0];
    assert.equal(first.preview, true);
    assert.equal(first.targetWorkspaceId, definition.bulk ? "ws-personal" : "default");
    assert.equal(
      first.url,
      definition.bulk ? "/api/workspaces/default/move" : "/api/workspaces/ws-personal/move",
    );
    if (definition.itemType) assert.ok(first.items.every((i) => i.type === definition.itemType));
    if (definition.itemId)
      assert.deepEqual(
        first.items.map((i) => i.id),
        definition.itemId,
      );
    if (didConfirm) {
      assert.equal(requests[1].preview, false);
      assert.equal(requests[1].confirm, true);
      assert.deepEqual(requests[1].items, first.items);
    }
  }
  return result;
}
