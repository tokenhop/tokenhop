"use client";

import PropTypes from "prop-types";
import Modal from "./Modal";
import Tabs from "./Tabs";
import SegmentedControl from "./SegmentedControl";
import Badge from "./Badge";
import Button from "./Button";
import Callout from "./Callout";
import CopyStatus from "./CopyStatus";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useManualSetupStore } from "@/store/manualSetupStore";
import { displayPath, manualMissingInputs } from "@/lib/cliToolConfigs/shared";

const OS_OPTIONS = [
  { value: "darwin", label: "macOS" },
  { value: "linux", label: "Linux" },
  { value: "win32", label: "Windows" },
];

const segments = (file) => file.split(/[\\/]/);

/** Tab label: the file name, with its folder when another file has the same name. */
const tabLabel = (file, files) => {
  const name = segments(file).at(-1);
  const clash = files.filter((other) => segments(other).at(-1) === name).length > 1;
  return clash ? segments(file).slice(-2).join("/") : name;
};

function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function CopyButton({ text, id, copyState, children, variant = "secondary" }) {
  const { copied, error, copy } = copyState;
  return (
    <>
      <Button
        variant={variant}
        size="sm"
        icon={copied === id ? "check" : error === id ? "error" : "content_copy"}
        onClick={() => copy(text, id)}
      >
        {copied === id ? "Copied" : error === id ? "Couldn't copy" : children}
      </Button>
      <CopyStatus copied={copied} error={error} id={id} />
    </>
  );
}

function FilePanel({ config, path, copyState, idPrefix }) {
  return (
    <div className="flex flex-col gap-3 pt-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <code dir="ltr" className="min-w-0 break-all font-mono text-[13px] text-text">
            {path}
          </code>
          <Badge variant="neutral" size="sm">
            {config.format}
          </Badge>
          <Badge variant={config.mode === "replace-file" ? "warn" : "info"} size="sm">
            {config.mode === "merge-keys" ? (
              <>Merge</>
            ) : config.mode === "create-file" ? (
              <>Create</>
            ) : (
              <>Replace</>
            )}
          </Badge>
        </div>
        <p className="text-[13px] text-muted">
          {config.note ||
            (config.mode === "merge-keys" ? (
              <>Merge these keys into the existing file. Keep everything else.</>
            ) : (
              <>Replace the file with this content, or create it.</>
            ))}
        </p>
      </div>
      <pre
        dir="ltr"
        className="max-h-[45vh] overflow-auto rounded-xl border border-line bg-raised px-3 py-2 font-mono text-xs whitespace-pre text-text"
      >
        {config.content}
      </pre>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon="download"
          onClick={() => download(segments(path).at(-1), config.content)}
        >
          Download
        </Button>
        <CopyButton text={config.content} id={`${idPrefix}-${path}`} copyState={copyState}>
          Copy
        </CopyButton>
      </div>
    </div>
  );
}

/**
 * Manual setup dialog: one tab per file with its per-OS path, format and merge
 * mode, readable code, copy/copy all/download, and an OS switch remembered per
 * viewer. Configs come from `toManualConfigs` (`{ file, format, mode, note, content }`).
 */
export default function ManualConfigModal({
  isOpen,
  onClose,
  title = "Manual configuration",
  configs = [],
}) {
  const platform = useManualSetupStore((s) => s.platform);
  const setPlatform = useManualSetupStore((s) => s.setPlatform);
  const copyState = useCopyToClipboard();
  const missing = manualMissingInputs(configs);
  const paths = configs.map((config) => displayPath(config.file, platform));
  const copyAll = configs
    .map((config, index) => `# ${paths[index]}\n${config.content.trimEnd()}\n`)
    .join("\n");

  const panel = (config, index) => (
    <FilePanel config={config} path={paths[index]} copyState={copyState} idPrefix="manualconfig" />
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="full">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl
            options={OS_OPTIONS}
            value={platform}
            onChange={setPlatform}
            size="sm"
            aria-label="Operating system"
          />
          {configs.length > 1 && missing.length === 0 && (
            <CopyButton text={copyAll} id="manualconfig-all" copyState={copyState}>
              Copy all
            </CopyButton>
          )}
        </div>
        {missing.length > 0 ? (
          <Callout variant="info" title="Complete these first">
            <ul className="list-disc ps-5">
              {missing.includes("model") && <li>Pick a model in the tool settings.</li>}
              {missing.includes("apiKey") && (
                <li>Choose an API key, or create one on the keys page.</li>
              )}
            </ul>
          </Callout>
        ) : configs.length === 1 ? (
          panel(configs[0], 0)
        ) : (
          <Tabs
            aria-label="Files to edit"
            tabs={configs.map((config, index) => ({
              value: String(index),
              label: <span dir="ltr">{tabLabel(paths[index], paths)}</span>,
              content: panel(config, index),
            }))}
          />
        )}
      </div>
    </Modal>
  );
}

const configShape = PropTypes.shape({
  file: PropTypes.string.isRequired,
  format: PropTypes.string,
  mode: PropTypes.oneOf(["merge-keys", "replace-file", "create-file"]),
  note: PropTypes.string,
  content: PropTypes.string.isRequired,
});

CopyButton.propTypes = {
  text: PropTypes.string.isRequired,
  id: PropTypes.string.isRequired,
  copyState: PropTypes.object.isRequired,
  children: PropTypes.node.isRequired,
  variant: PropTypes.string,
};

FilePanel.propTypes = {
  config: configShape.isRequired,
  path: PropTypes.string.isRequired,
  copyState: PropTypes.object.isRequired,
  idPrefix: PropTypes.string.isRequired,
};

ManualConfigModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  title: PropTypes.string,
  configs: PropTypes.arrayOf(configShape),
};
