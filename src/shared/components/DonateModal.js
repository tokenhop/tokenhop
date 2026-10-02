"use client";

import PropTypes from "prop-types";
import { ACTIVE } from "@/shared/brand";
import Modal from "./Modal";
import Button from "./Button";

const CHANNELS = [
  {
    id: "buymeacoffee",
    label: "Buy Me a Coffee",
    description: "Support development",
    icon: "local_cafe",
    url: "https://buymeacoffee.com/yandyr",
    qr: "/donate/buymeacoffee.svg",
  },
  // ponytail: placeholders; add url/qr when more channels exist.
  {
    id: "placeholder-1",
    label: "More options",
    description: "Another way to support",
    icon: "favorite",
  },
  {
    id: "placeholder-2",
    label: "More options",
    description: "Another way to support",
    icon: "payments",
  },
];

/**
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 */
export default function DonateModal({ isOpen, onClose }) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="material-symbols-outlined text-coral" aria-hidden="true">
            volunteer_activism
          </span>
          {`Support ${ACTIVE.slug}`}
        </span>
      }
      size="full"
    >
      <p className="mb-6 text-center text-sm text-muted">
        {`If ${ACTIVE.name} helps your work, consider supporting development.`}
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {CHANNELS.map((channel) => (
          <DonateChannelCard key={channel.id || channel.label} channel={channel} />
        ))}
      </div>
    </Modal>
  );
}

DonateModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};

function DonateChannelCard({ channel }) {
  const { label, description, icon, url, qr } = channel;
  return (
    <div className="flex flex-col items-center rounded-xl border border-line bg-raised p-4 transition-colors hover:border-coral/40">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-coral-bg text-coral">
        <span className="material-symbols-outlined text-[26px]" aria-hidden="true">
          {icon || "volunteer_activism"}
        </span>
      </div>
      <div className="mb-1 font-semibold text-text">{label}</div>
      {description && <div className="mb-3 text-center text-xs text-muted">{description}</div>}
      {qr ? (
        // biome-ignore lint/performance/noImgElement: static local SVG QR
        <img
          src={qr}
          alt={`${label} QR code`}
          className="aspect-square w-full max-w-[180px] rounded-lg bg-white p-2"
        />
      ) : (
        <div className="flex aspect-square w-full max-w-[180px] items-center justify-center rounded-lg border border-dashed border-line text-muted">
          <span className="material-symbols-outlined text-4xl" aria-hidden="true">
            add
          </span>
        </div>
      )}
      {!url && (
        <div className="mt-3 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-muted">
          Coming soon
        </div>
      )}
      {url ? (
        <Button
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          variant="primary"
          size="sm"
          iconRight="open_in_new"
          className="mt-3"
        >
          Open
        </Button>
      ) : null}
    </div>
  );
}

DonateChannelCard.propTypes = {
  channel: PropTypes.shape({
    id: PropTypes.string,
    label: PropTypes.string,
    description: PropTypes.string,
    icon: PropTypes.string,
    url: PropTypes.string,
    qr: PropTypes.string,
  }).isRequired,
};
