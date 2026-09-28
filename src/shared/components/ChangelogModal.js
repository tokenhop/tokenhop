"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { marked } from "marked";
import { GITHUB_CONFIG } from "@/shared/constants/appConfig";
import Modal from "./Modal";
import { LoadingState } from "./StateViews";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Project change log rendered from the configured markdown URL. Fetched on
 * first open, then cached for the component lifetime.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 */
export default function ChangelogModal({ isOpen, onClose }) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen || html) return;
    setLoading(true);
    setError("");
    fetch(GITHUB_CONFIG.changelogUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((md) => setHtml(marked.parse(md)))
      .catch((err) => setError(err.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [isOpen, html]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Change Log" size="full">
      <div aria-live="polite">
        {loading && <LoadingState lines={6} label="Loading changelog" className="py-4" />}
        {error && (
          <p role="alert" className="py-4 text-err">
            Failed to load changelog: {error}
          </p>
        )}
      </div>
      {!loading && !error && html && (
        <div
          className="changelog-body text-text"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown from the project's own changelog URL
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </Modal>
  );
}

ChangelogModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
