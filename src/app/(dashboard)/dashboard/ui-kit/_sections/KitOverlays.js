"use client";

import { useState } from "react";
import Button from "@/shared/components/Button";
import { ConfirmDialog } from "@/shared/components/Modal";
import Modal from "@/shared/components/Modal";
import Drawer from "@/shared/components/Drawer";
import Menu, { MenuItem } from "@/shared/components/Menu";
import Popover from "@/shared/components/Popover";
import Tooltip from "@/shared/components/Tooltip";

/** Kit section: Signal overlays — modal, confirm, drawer, menu, popover, tooltip. */
export default function KitOverlays() {
  const [modalOpen, setModalOpen] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);

  return (
    <section
      aria-labelledby="kit-overlays"
      className="rounded-2xl border border-line bg-panel p-6 shadow-card"
    >
      <h2 id="kit-overlays" className="font-display text-xl font-bold">
        Overlays
      </h2>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setModalOpen(true)}>
          Open modal
        </Button>
        <Button variant="danger" onClick={() => setDangerOpen(true)}>
          Open danger confirm
        </Button>
        <Button variant="ghost" onClick={() => setErrorOpen(true)}>
          Open confirm with error
        </Button>
        <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
          Open drawer
        </Button>
        <Menu trigger={<Button variant="secondary">Open menu</Button>} align="start">
          <MenuItem icon="history" label="Change Log" onSelect={() => {}}>
            Change Log
          </MenuItem>
          <MenuItem icon="dark_mode" label="Theme" selected onSelect={() => {}}>
            Theme
          </MenuItem>
          <MenuItem icon="lock" label="Settings" disabled onSelect={() => {}}>
            Settings
          </MenuItem>
          <MenuItem icon="power_settings_new" label="Shutdown" danger onSelect={() => {}}>
            Shutdown
          </MenuItem>
          <MenuItem icon="logout" label="Logout" danger onSelect={() => {}}>
            Logout
          </MenuItem>
        </Menu>
        <Popover
          trigger={<Button variant="secondary">Open popover</Button>}
          aria-label="Kit popover"
        >
          <p className="text-sm text-muted">Non-modal panel. Esc closes, focus returns.</p>
        </Popover>
        <Tooltip text="Shows on hover and focus" position="top">
          <Button variant="ghost">Hover me</Button>
        </Tooltip>
        <Tooltip text="Error-tinted tip" variant="err">
          <Button variant="ghost">Error tip</Button>
        </Tooltip>
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Kit modal"
        description="Composed dialog: focus trap, Esc/backdrop close, scroll lock."
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setModalOpen(false)}>Save</Button>
          </>
        }
      >
        <p className="text-sm text-muted">Modal body content goes here.</p>
      </Modal>

      <ConfirmDialog
        isOpen={dangerOpen}
        onClose={() => setDangerOpen(false)}
        onConfirm={() => setDangerOpen(false)}
        title="Delete provider?"
        message="This removes the connection. The request logs stay."
        confirmText="Delete"
        variant="danger"
      />

      <ConfirmDialog
        isOpen={errorOpen}
        onClose={() => setErrorOpen(false)}
        onConfirm={() => {
          throw new Error("Refresh failed (401). Sign in again and retry.");
        }}
        title="Refresh token?"
        message="Async failure stays inline under role=alert."
        confirmText="Retry"
        variant="default"
      />

      <Drawer isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} title="Kit drawer">
        <p className="text-sm text-muted">Full-height inline-end panel. Esc closes.</p>
      </Drawer>
    </section>
  );
}
