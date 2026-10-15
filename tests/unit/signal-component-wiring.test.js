// Static component wiring (split from signal-overlay-focus.test.js). Kept as its own
// file so both stay under the soft 500-line cap; behavior tests live with the trap tests.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

describe("component wiring", () => {
  for (const file of ["Modal.js", "Drawer.js"]) {
    it(`${file} portals a tabindex=-1 modal dialog wired to the trap and dismiss hooks`, () => {
      const src = readFileSync(resolve(SRC, "shared/components", file), "utf8");
      for (const needle of [
        "<Portal>",
        'role="dialog"',
        'aria-modal="true"',
        "tabIndex={-1}",
        "useFocusTrap({ container: panel, active: open, initialFocusRef",
        "ref={setPanelNode}",
        "useDismiss({",
        "useScrollLock(open)",
      ]) {
        expect(src, `${file} missing ${needle}`).toContain(needle);
      }
    });
  }
  it("Tooltip uses the Esc guard and hides via tooltipVisible", () => {
    const src = readFileSync(resolve(SRC, "shared/components/Tooltip.js"), "utf8");
    expect(src).toContain("createEscapeGuard(window");
    expect(src).toContain("tooltipVisible(openState, disabled, text)");
    expect(src).not.toMatch(/document\.addEventListener\("keydown"/);
  });
  it("useFocusTrap has no frame-retry attach (panel node drives it)", () => {
    const src = readFileSync(resolve(SRC, "shared/hooks/useOverlay.js"), "utf8");
    expect(src).not.toContain("requestAnimationFrame");
    expect(src).not.toContain("MOUNT_RETRY_FRAMES");
  });
  for (const [file, needle] of [
    ["shared/components/ComboFormModal.js", 'if (e.key === "Escape") {\n      e.preventDefault();'],
    [
      "shared/components/combos/ComboEditor.js",
      'if (e.key === "Escape") {\n                    // Claim Esc for the inline rename',
    ],
  ]) {
    it(`${file}: inline editor claims Esc so the parent dialog stays open`, () => {
      expect(readFileSync(resolve(SRC, file), "utf8")).toContain(needle);
    });
  }
});

const dashboard = "app/(dashboard)/dashboard/";
const source = (file) => readFileSync(resolve(SRC, file), "utf8");
describe("workspace move owner wiring", () => {
  it("combos heading survives the empty list and reaches the move dialog", () => {
    const page = source(`${dashboard}combos/CombosPageClient.js`);
    expect(page).toContain("ref={combosHeadingRef} tabIndex={-1}");
    expect(page.indexOf("ref={combosHeadingRef}")).toBeLessThan(
      page.indexOf("{combos.length === 0 ?"),
    );
    expect(page).toContain("successFocusRef={combosHeadingRef}");
    expect(source("shared/components/combos/SortableComboCard.js")).toContain(
      "successFocusRef={successFocusRef}",
    );
  });
  it("connections use the persistent card heading, not a removable row", () => {
    const page = source(`${dashboard}providers/detail/ConnectionsSection.js`);
    expect(page).toContain("headingRef={focusTargetRef}");
    expect(page).toContain("successFocusRef={focusTargetRef}");
    expect(source(`${dashboard}providers/detail/SortableConnectionRow.js`)).toContain(
      "successFocusRef={successFocusRef}",
    );
  });
  it("models thread one heading through catalog aliases, custom models and disabled lists", () => {
    const page = source(`${dashboard}providers/detail/ModelsSection.js`);
    expect(page).toContain("headingRef={focusTargetRef}");
    expect(page.match(/successFocusRef=\{focusTargetRef\}/g)).toHaveLength(3);
    expect(source(`${dashboard}providers/[id]/ModelRow.js`)).toContain(
      "successFocusRef={successFocusRef}",
    );
    expect(source(`${dashboard}providers/detail/CompatibleModelsSection.js`)).toContain(
      "successFocusRef={successFocusRef}",
    );
  });
  it("provider detail shares model heading refs and keeps its node H1 mounted after refresh", () => {
    const page = source(`${dashboard}providers/detail/ProviderDetailPage.js`);
    for (const prop of [
      "titleRef={headerFocusTargetRef}",
      "successFocusRef={headerFocusTargetRef}",
      "headingRef={modelsFocusTargetRef}",
      "successFocusRef={modelsFocusTargetRef}",
    ])
      expect(page).toContain(prop);
    expect(page).toContain("lastProviderInfo.current?.providerId === providerId");
    expect(page).not.toContain("setLoading(true)");
    expect(source(`${dashboard}providers/detail/ProviderDetailHeader.js`)).toContain(
      "<PageTitle titleRef={titleRef}>",
    );
  });
  it("desktop and mobile API keys share the persistent card heading", () => {
    const page = source(`${dashboard}endpoint/components/ApiKeysCard.js`);
    expect(page).toContain("headingRef={headingRef}");
    expect(page.match(/successFocusRef=\{headingRef\}/g)).toHaveLength(2);
    expect(source(`${dashboard}endpoint/EndpointPageClient.js`)).toContain("<ApiKeysCard");
  });
  it("both bulk stages return to the outer persistent trigger", () => {
    const page = source(`${dashboard}providers/components/MoveFromDefault.js`);
    expect(page).toContain("ref={triggerRef}");
    expect(page.match(/returnFocusRef=\{triggerRef\}/g)).toHaveLength(2);
    expect(source(`${dashboard}providers/ProvidersListShell.js`)).toContain(
      "<MoveFromDefault view={authView} onMoved={refreshData}",
    );
  });
});
