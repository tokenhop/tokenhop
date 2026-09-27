import { useState } from "react";
import PropTypes from "prop-types";
import { CapacityBadges, IconButton } from "@/shared/components";
import CopyStatus from "@/shared/components/CopyStatus";

const STATUS_ICON = { ok: "check_circle", error: "cancel" };
const STATUS_TONE = { ok: "text-ok border-ok/40", error: "text-err border-err/40" };

/**
 * Signal model row: status icon, mono model id (with thinking suffix),
 * display name, capability icons and Test / Copy / Remove actions.
 * Used for built-in, custom and compatible-provider models.
 */
export default function ModelRow({
  model,
  fullModel,
  alias,
  copied,
  copyError,
  onCopy,
  onSetAlias,
  testStatus,
  isCustom,
  isFree,
  onDeleteAlias,
  onTest,
  isTesting,
  onDisable,
  caps,
  thinkingSuffix,
}) {
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasOpen, setAliasOpen] = useState(false);
  const tone = STATUS_TONE[testStatus] || "text-muted border-line";
  const copyKey = `model-${model.id}`;
  const removeLabel = isCustom ? "Remove custom model" : "Disable this model";
  const onRemove = isCustom ? onDeleteAlias : onDisable;

  return (
    <li
      className={`flex min-w-0 max-w-full list-none items-center gap-2 rounded-xl border bg-raised px-3 py-2 ${tone.split(" ")[1]}`}
    >
      <span
        className={`material-symbols-outlined shrink-0 text-base ${tone.split(" ")[0]}`}
        aria-hidden="true"
      >
        {STATUS_ICON[testStatus] || "smart_toy"}
      </span>
      <span className="sr-only">
        {testStatus === "ok" ? "Reachable" : testStatus === "error" ? "Not reachable" : ""}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <code className="truncate font-mono text-xs text-text sm:max-w-[360px]">
          {displayModel}
        </code>
        {model.name || caps || isFree ? (
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
            {model.name ? <span className="truncate">{model.name}</span> : null}
            {isFree ? <span className="font-semibold text-ok">Free</span> : null}
            <CapacityBadges caps={caps} colorOverride="text-muted" size={12} />
          </span>
        ) : null}
      </div>
      {onTest ? (
        <IconButton
          icon="science"
          label={isTesting ? `Testing ${displayModel}` : `Test ${displayModel}`}
          loading={isTesting}
          onClick={onTest}
        />
      ) : null}
      <IconButton
        icon={copied === copyKey ? "check" : copyError === copyKey ? "error" : "content_copy"}
        label={
          copied === copyKey
            ? `Copied ${displayModel}`
            : copyError === copyKey
              ? `Couldn't copy ${displayModel}`
              : `Copy ${displayModel}`
        }
        onClick={() => onCopy(displayModel, copyKey)}
      />
      <CopyStatus copied={copied} error={copyError} id={copyKey} />
      {!isCustom && onSetAlias ? (
        alias ? (
          <span className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono text-[11px] text-coral-ink">{alias}</code>
            <IconButton
              icon="close"
              label={`Remove alias ${alias} for ${displayModel}`}
              onClick={onDeleteAlias}
              className="hover:text-err"
            />
          </span>
        ) : aliasOpen ? (
          <span className="flex min-w-0 items-center gap-1">
            <input
              aria-label={`Alias for ${displayModel}`}
              value={aliasDraft}
              onChange={(event) => setAliasDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && aliasDraft.trim()) {
                  onSetAlias(aliasDraft.trim());
                  setAliasDraft("");
                  setAliasOpen(false);
                } else if (event.key === "Escape") {
                  setAliasDraft("");
                  setAliasOpen(false);
                }
              }}
              placeholder="alias"
              className="h-9 w-28 rounded-lg border border-line bg-panel px-2 font-mono text-xs text-text outline-none focus:border-coral"
            />
            <IconButton
              icon="check"
              label={`Save alias for ${displayModel}`}
              onClick={() => {
                if (!aliasDraft.trim()) return;
                onSetAlias(aliasDraft.trim());
                setAliasDraft("");
                setAliasOpen(false);
              }}
            />
          </span>
        ) : (
          <IconButton
            icon="label"
            label={`Set alias for ${displayModel}`}
            onClick={() => setAliasOpen(true)}
          />
        )
      ) : null}
      {onRemove ? (
        <IconButton
          icon="close"
          label={`${removeLabel} ${displayModel}`}
          onClick={onRemove}
          className="hover:text-err"
        />
      ) : null}
    </li>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  copyError: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onSetAlias: PropTypes.func,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
};
