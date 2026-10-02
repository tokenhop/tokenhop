"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import {
  Button,
  Card,
  EmptyState,
  SegmentedControl,
  Skeleton,
  StatusPill,
} from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";
import {
  ENTRY_SKILL_ID,
  SKILLS,
  SKILLS_BLOB_BASE,
  SKILLS_REPO_URL,
  getAvailableSkillBases,
  getHostedSkillUrl,
} from "@/shared/constants/skills";

/** Dashboard fetches need the JWT cookie, not the cached LLM handlers. */
const DASHBOARD_FETCH_INIT = { cache: "no-store", credentials: "same-origin" };

/**
 * Pick the open URL for a skill card: the blob page for real markdown files,
 * else the plain GitHub tree (kept honest — no fake per-skill pages).
 * @param {{ id: string, path?: string }} skill Skill entry from SKILLS.
 * @returns {string} GitHub URL to open in a new tab.
 */
export function getSkillOpenUrl(skill) {
  return skill.path ? `${SKILLS_BLOB_BASE}/${skill.path}` : `${SKILLS_REPO_URL}/tree/master/skills`;
}

/**
 * Copy the hero entry-skill line. Announces "Copied" (or the failure) via a
 * polite live region next to the primary button.
 * @param {{ value: string }} props
 */
function HeroCopyButton({ value }) {
  const { copied, error, copy } = useCopyToClipboard(2000);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="primary"
        icon={copied ? "check" : error ? "error" : "content_copy"}
        onClick={() => copy(value)}
        aria-label="Copy entry skill line"
      >
        {copied ? "Copied" : error ? "Couldn't copy" : "Copy"}
      </Button>
      <CopyStatus copied={copied} error={error} />
    </span>
  );
}

HeroCopyButton.propTypes = {
  value: PropTypes.string.isRequired,
};

/**
 * Copy link for one skill with an aria-live confirmation.
 * @param {{ url: string, skillName: string }} props
 */
function SkillCopyButton({ url, skillName }) {
  const { copied, error, copy } = useCopyToClipboard(2000);
  const done = copied === url;
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        icon={done ? "check" : error === url ? "error" : "content_copy"}
        onClick={() => copy(url, url)}
        aria-label={`Copy link for ${skillName}`}
      >
        {done ? "Copied" : error === url ? "Couldn't copy" : "Copy link"}
      </Button>
      <CopyStatus copied={copied} error={error} id={url} />
    </span>
  );
}

SkillCopyButton.propTypes = {
  url: PropTypes.string.isRequired,
  skillName: PropTypes.string.isRequired,
};

/**
 * One skill: icon tile, name (+ Start here), description, endpoint mono,
 * open-in-new-tab, copy link.
 * @param {{ skill: object, baseUrl: string }} props
 */
function SkillCard({ skill, baseUrl }) {
  const url = getHostedSkillUrl(baseUrl, skill.id);
  const openUrl = getSkillOpenUrl(skill);
  return (
    <Card
      padding="md"
      className={skill.isEntry ? "border-coral shadow-focus" : undefined}
      aria-labelledby={`skill-${skill.id}`}
    >
      <div className="flex flex-wrap items-center gap-3.5">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-coral-bg text-coral-ink"
        >
          <span className="material-symbols-outlined text-[20px]">{skill.icon}</span>
        </span>
        <div className="min-w-48 flex-1">
          <h2
            id={`skill-${skill.id}`}
            className="flex flex-wrap items-center gap-2 text-[15px] font-semibold"
          >
            {skill.name}
            {skill.isEntry && (
              <StatusPill variant="live" size="sm">
                Start here
              </StatusPill>
            )}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">{skill.description}</p>
          {skill.endpoint && (
            <code className="mt-1 block truncate font-mono text-[11px] text-subtle">
              {skill.endpoint}
            </code>
          )}
        </div>
        <div className="ms-auto flex items-center gap-2">
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:text-text focus-visible:shadow-focus"
          >
            <span className="sr-only">Open {skill.name} on GitHub</span>
            <span
              className="material-symbols-outlined text-[16px] rtl:-scale-x-100"
              aria-hidden="true"
            >
              open_in_new
            </span>
          </a>
          <SkillCopyButton url={url} skillName={skill.name} />
        </div>
      </div>
    </Card>
  );
}

SkillCard.propTypes = {
  skill: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    description: PropTypes.string.isRequired,
    endpoint: PropTypes.string,
    icon: PropTypes.string.isRequired,
    isEntry: PropTypes.bool,
    path: PropTypes.string,
  }).isRequired,
  baseUrl: PropTypes.string.isRequired,
};

/**
 * Skills page. Hero pastes the entry-skill URL for the selected base; cards
 * copy per-skill hosted URLs; GitHub card links the source repo.
 */
export default function SkillsPageClient() {
  const [bases, setBases] = useState(null);
  const [selected, setSelected] = useState("local");
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const statusRes = await fetch("/api/tunnel/status", DASHBOARD_FETCH_INIT);
        if (!statusRes.ok) throw new Error(`Tunnel status ${statusRes.status}`);
        const status = await statusRes.json();
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        if (!origin) throw new Error("No local origin");
        if (!cancelled) {
          setBases(getAvailableSkillBases(origin, status));
          setError(null);
        }
      } catch {
        if (!cancelled) {
          try {
            const origin = typeof window !== "undefined" ? window.location.origin : "";
            setBases(getAvailableSkillBases(origin || "http://localhost:20128", {}));
            setError("Remote bases unavailable; showing Local only.");
          } catch {
            if (!cancelled) setError("Could not load access bases.");
          }
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const active = bases?.find((base) => base.value === selected) ?? bases?.[0] ?? null;
  const activeUrl = active ? active.url : "";
  const heroValue = active
    ? `Read this skill and use it: ${getHostedSkillUrl(active.url, ENTRY_SKILL_ID)}`
    : "";

  return (
    <div className="flex flex-col gap-5">
      <Card padding="lg" aria-labelledby="skills-hero">
        <div className="flex flex-wrap items-center gap-3">
          <span
            id="skills-hero"
            className="flex-1 text-xs font-semibold tracking-[0.08em] text-muted uppercase"
          >
            Paste this to your AI
          </span>
          {bases ? (
            <SegmentedControl
              aria-label="Skill URL base"
              value={active?.value ?? "local"}
              onChange={setSelected}
              options={bases.map((base) => ({ value: base.value, label: base.label }))}
            />
          ) : (
            <Skeleton className="h-11 w-48" />
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {active ? (
            <>
              <code
                dir="ltr"
                className="flex h-11 min-w-0 flex-1 items-center rounded-lg border border-line bg-raised px-3 font-mono text-sm text-text"
              >
                <span className="truncate">{heroValue}</span>
              </code>
              <HeroCopyButton value={heroValue} />
            </>
          ) : (
            <Skeleton className="h-16 w-full" />
          )}
        </div>
        <p className="mt-3 text-[13px] text-muted">
          The entry skill explains your endpoint and keys, then points the agent to the right skill
          below.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-[13px] text-warn">
            {error}
          </p>
        )}
      </Card>

      {active ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {SKILLS.map((skill) => (
            <SkillCard key={skill.id} skill={skill} baseUrl={activeUrl} />
          ))}
        </div>
      ) : error && !active ? (
        <EmptyState
          icon="error"
          title="Could not load skills"
          description="The local origin is unavailable. Reload the page to try again."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2" aria-hidden="true">
          {["s1", "s2", "s3", "s4"].map((key) => (
            <Skeleton key={key} className="h-32 w-full" />
          ))}
        </div>
      )}

      <Card padding="md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">More on GitHub</h2>
            <p className="mt-0.5 text-xs text-muted">Browse source, README, and examples.</p>
          </div>
          <a
            href={`${SKILLS_REPO_URL}/tree/master/skills`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-line bg-raised px-4 text-sm font-semibold transition-colors hover:text-text focus-visible:shadow-focus"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              open_in_new
            </span>
            View on GitHub
          </a>
        </div>
      </Card>
    </div>
  );
}
