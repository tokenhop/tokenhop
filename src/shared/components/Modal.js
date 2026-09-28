"use client";

import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import {
  MODAL_SIZES,
  confirmMayStart,
  confirmSettleFresh,
  modalSizeClass,
} from "./overlayPrimitives";
import {
  Portal,
  useDismiss,
  useFocusTrap,
  useNodeRef,
  useOverlayIds,
  useScrollLock,
} from "@/shared/hooks/useOverlay";
import Button from "./Button";
import IconButton from "./IconButton";

const ModalContext = createContext(null);

function useModalContext(part) {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error(`Modal.${part} must be rendered inside <Modal>`);
  return ctx;
}

/** Dialog header: title (wired to aria-labelledby) + labeled close button. */
function ModalHeader({ children, className }) {
  const { titleId, onClose } = useModalContext("Header");
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-3 border-b border-line py-3 ps-6 pe-3",
        className,
      )}
    >
      <h2 id={titleId} className="min-w-0 font-display text-lg font-bold text-text">
        {children}
      </h2>
      {onClose ? <IconButton icon="close" label="Close" onClick={onClose} /> : null}
    </div>
  );
}

ModalHeader.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
};

/** Scrollable dialog body. */
function ModalBody({ children, className }) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-5 custom-scrollbar", className)}>
      {children}
    </div>
  );
}

ModalBody.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
};

/** Dialog footer: end-aligned actions. */
function ModalFooter({ children, className }) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

ModalFooter.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
};

const PARTS = new Set([ModalHeader, ModalBody, ModalFooter]);
const isComposed = (children) =>
  Children.toArray(children).some((child) => isValidElement(child) && PARTS.has(child.type));

/**
 * Signal modal dialog (design-system §4/§6/§8). Portaled, focus-trapped, Esc
 * and backdrop close (topmost overlay only), returns focus to the trigger,
 * ref-counted scroll lock, 280ms transform/opacity entry (none under reduced
 * motion).
 *
 * Two ways to fill it:
 * - props: `title` + `children` + `footer` (legacy API, unchanged);
 * - composition: `<Modal.Header>`, `<Modal.Body>`, `<Modal.Footer>` children.
 *
 * `showTrafficLights` is accepted and ignored until phase B removes it.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} [props.onClose]
 * @param {React.ReactNode} [props.title]
 * @param {React.ReactNode} [props.description] Wired to aria-describedby.
 * @param {React.ReactNode} [props.children]
 * @param {React.ReactNode} [props.footer]
 * @param {"sm"|"md"|"lg"|"xl"|"full"} [props.size="md"]
 * @param {boolean} [props.closeOnOverlay=true]
 * @param {boolean} [props.closeOnEscape=true]
 * @param {React.RefObject<HTMLElement>} [props.initialFocusRef]
 * @param {string} [props.aria-label] Name when there is no visible title.
 * @param {string} [props.className]
 */
export default function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnOverlay = true,
  closeOnEscape = true,
  initialFocusRef,
  "aria-label": ariaLabel,
  className,
  showTrafficLights: _showTrafficLights,
}) {
  const panelRef = useRef(null);
  const [panel, setPanelNode] = useNodeRef(panelRef);
  const { titleId, descriptionId } = useOverlayIds("signal-modal");
  const open = Boolean(isOpen);
  useScrollLock(open);
  useFocusTrap({ container: panel, active: open, initialFocusRef });
  useDismiss({
    onClose,
    containerRef: panelRef,
    enabled: open,
    closeOnEscape,
    closeOnOutside: closeOnOverlay,
  });
  if (!open) return null;

  const composed = isComposed(children);
  const labelled = Boolean(title) || composed;

  return (
    <Portal>
      <ModalContext.Provider value={{ titleId, onClose }}>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="signal-backdrop absolute inset-0" aria-hidden="true" />
          <div
            ref={setPanelNode}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelled && !ariaLabel ? titleId : undefined}
            aria-label={ariaLabel}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            className={cn(
              "signal-overlay-modal relative flex max-h-[85vh] w-full flex-col overflow-hidden",
              "rounded-2xl border border-line bg-panel text-text shadow-card outline-none",
              modalSizeClass(size),
              className,
            )}
          >
            {composed ? (
              children
            ) : (
              <>
                {title ? <ModalHeader>{title}</ModalHeader> : null}
                <ModalBody>
                  {description ? (
                    <p id={descriptionId} className="mb-3 text-sm text-muted">
                      {description}
                    </p>
                  ) : null}
                  {children}
                </ModalBody>
                {footer ? <ModalFooter>{footer}</ModalFooter> : null}
              </>
            )}
            {composed && description ? (
              <p id={descriptionId} className="sr-only">
                {description}
              </p>
            ) : null}
          </div>
        </div>
      </ModalContext.Provider>
    </Portal>
  );
}

Modal.Header = ModalHeader;
Modal.Body = ModalBody;
Modal.Footer = ModalFooter;

Modal.propTypes = {
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
  title: PropTypes.node,
  description: PropTypes.node,
  children: PropTypes.node,
  footer: PropTypes.node,
  size: PropTypes.oneOf(Object.keys(MODAL_SIZES)),
  closeOnOverlay: PropTypes.bool,
  closeOnEscape: PropTypes.bool,
  initialFocusRef: PropTypes.shape({ current: PropTypes.any }),
  "aria-label": PropTypes.string,
  className: PropTypes.string,
  showTrafficLights: PropTypes.bool,
};

/**
 * Confirmation dialog, `default` or `danger`. `onConfirm` may be async: the
 * confirm button shows loading until it settles. A rejection is shown inline
 * (role="alert") and the dialog stays open. A resolved confirm does not close
 * the dialog — the caller closes it from `onConfirm` or `onClose`. Pass
 * `loading`/`error` to control those states from outside instead.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {() => (void|Promise<unknown>)} props.onConfirm
 * @param {React.ReactNode} [props.title="Confirm"]
 * @param {React.ReactNode} [props.message]
 * @param {string} [props.confirmText="Confirm"]
 * @param {string} [props.cancelText="Cancel"]
 * @param {"danger"|"default"|"primary"} [props.variant="danger"] `primary` is the legacy name of `default`.
 * @param {boolean} [props.loading]
 * @param {React.ReactNode} [props.error]
 */
export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title = "Confirm",
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  loading,
  error,
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);
  const busy = Boolean(loading) || pending;
  const shownError = error ?? failure;
  const confirmLockRef = useRef(false);
  const confirmRequestRef = useRef(0);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  // Closing invalidates any in-flight confirm: its settle is stale, so reset
  // the local busy/error state here instead, ready for the next open.
  useEffect(() => {
    if (isOpen) return;
    confirmRequestRef.current += 1;
    confirmLockRef.current = false;
    setPending(false);
    setFailure(null);
  }, [isOpen]);

  const close = () => {
    if (busy) return;
    setFailure(null);
    onClose?.();
  };

  const confirm = async () => {
    if (!confirmMayStart(confirmLockRef, busy)) return;
    confirmLockRef.current = true;
    const requestId = confirmRequestRef.current + 1;
    confirmRequestRef.current = requestId;
    setFailure(null);
    setPending(true);
    try {
      await onConfirm();
    } catch (err) {
      if (!confirmSettleFresh(requestId, confirmRequestRef, isOpenRef.current)) return;
      setFailure(err?.message || "Something went wrong. Try again.");
    } finally {
      // Stale settles (superseded request, or closed mid-flight) write
      // nothing: pending/error would otherwise leak into the next open.
      if (confirmSettleFresh(requestId, confirmRequestRef, isOpenRef.current)) {
        setPending(false);
      }
      if (confirmRequestRef.current === requestId) confirmLockRef.current = false;
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={title}
      description={message}
      size="sm"
      closeOnOverlay={!busy}
      closeOnEscape={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {cancelText}
          </Button>
          <Button
            variant={variant === "danger" ? "danger" : "primary"}
            onClick={confirm}
            loading={busy}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <div aria-live="polite">
        {shownError ? (
          <p role="alert" className="rounded-lg bg-err-bg px-3 py-2 text-sm text-err">
            {shownError}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

ConfirmDialog.propTypes = {
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
  onConfirm: PropTypes.func.isRequired,
  title: PropTypes.node,
  message: PropTypes.node,
  confirmText: PropTypes.string,
  cancelText: PropTypes.string,
  variant: PropTypes.oneOf(["danger", "default", "primary"]),
  loading: PropTypes.bool,
  error: PropTypes.node,
};

/** Legacy name kept so existing call sites work unchanged. */
export const ConfirmModal = ConfirmDialog;
