"use client";

import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "./CopyStatus";

/**
 * Read-only manual configuration snippets with per-file copy.
 * Shared by the modal and the remote CLI-tools panel.
 */
export function ManualConfigList({ configs = [], idPrefix = "manualconfig" }) {
  const { copied, error, copy } = useCopyToClipboard();

  if (configs.length === 0) {
    return <p className="text-[13px] text-muted">Pick a model to see the configuration.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {configs.map((config, index) => {
        const copyId = `${idPrefix}-${index}`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: registry-owned configs have no stable ids
          <div key={`${config.filename}-${index}`} className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text">{config.filename}</span>
              <Button
                variant="ghost"
                size="sm"
                icon={copied === copyId ? "check" : error === copyId ? "error" : "content_copy"}
                onClick={() => copy(config.content, copyId)}
              >
                {copied === copyId ? "Copied!" : error === copyId ? "Couldn't copy" : "Copy"}
              </Button>
              <CopyStatus copied={copied} error={error} id={copyId} />
            </div>
            <pre className="max-h-60 overflow-x-auto overflow-y-auto rounded border border-line bg-raised px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">
              {config.content}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

export default function ManualConfigModal({
  isOpen,
  onClose,
  title = "Manual Configuration",
  configs = [],
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="xl">
      <ManualConfigList configs={configs} />
    </Modal>
  );
}

ManualConfigList.propTypes = {
  configs: PropTypes.arrayOf(
    PropTypes.shape({ filename: PropTypes.string, content: PropTypes.string }),
  ),
  idPrefix: PropTypes.string,
};

ManualConfigModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  title: PropTypes.string,
  configs: PropTypes.arrayOf(
    PropTypes.shape({ filename: PropTypes.string, content: PropTypes.string }),
  ),
};
