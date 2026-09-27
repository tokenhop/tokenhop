"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";

const TAG_STYLE = {
  new: "bg-coral-bg text-coral",
  experimental: "bg-raised text-muted",
};

function sectionTags(section) {
  return [...new Set(section.rows.flatMap((row) => row.tags ?? []))].filter(
    (tag) => TAG_STYLE[tag],
  );
}

/**
 * Two-level settings navigation: group tabs across the top, section list down
 * the side. Each section is its own view, addressable by `#section-id`.
 */
export default function SettingsNav({ groups, sections, activeId, onSelect }) {
  const byId = Object.fromEntries(sections.map((section) => [section.id, section]));
  const activeGroup = groups.find((group) => group.sections.includes(activeId)) ?? groups[0];

  return (
    <>
      <nav
        aria-label="Settings groups"
        className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:col-span-2"
      >
        {groups.map((group) => {
          const active = group.id === activeGroup.id;
          return (
            <button
              key={group.id}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(group.sections[0])}
              className={cn(
                "group flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all outline-none focus-visible:shadow-focus",
                active
                  ? "border-coral/40 bg-coral-bg shadow-card"
                  : "border-line bg-panel hover:-translate-y-0.5 hover:bg-raised",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "material-symbols-outlined flex size-9 shrink-0 items-center justify-center rounded-lg text-[20px]",
                  active ? "bg-coral text-bg" : "bg-raised text-muted group-hover:text-text",
                )}
              >
                {group.icon}
              </span>
              <span className="min-w-0">
                <span
                  className={cn("block text-sm font-semibold", active ? "text-coral" : "text-text")}
                >
                  {group.title}
                </span>
                <span className="block truncate text-xs text-muted">
                  {group.sections.map((id) => byId[id]?.title).join(" · ")}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      <nav
        aria-label={`${activeGroup.title} sections`}
        className="lg:sticky lg:top-0 lg:self-start"
      >
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:flex lg:flex-col">
          {activeGroup.sections.map((id) => {
            const section = byId[id];
            if (!section) return null;
            const active = id === activeId;
            const danger = id === "danger";
            return (
              <li key={id} className="min-w-0">
                <a
                  href={`#${id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onSelect(id);
                  }}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors outline-none focus-visible:shadow-focus",
                    active ? "bg-panel shadow-card" : "hover:bg-raised",
                    active &&
                      "lg:before:absolute lg:before:inset-y-2 lg:before:left-0 lg:before:w-0.5 lg:before:rounded-full lg:before:bg-coral",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "material-symbols-outlined mt-0.5 text-[18px]",
                      danger ? "text-err" : active ? "text-coral" : "text-muted",
                    )}
                  >
                    {section.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-semibold whitespace-nowrap text-text">
                      {section.title}
                      {sectionTags(section).map((tag) => (
                        <span
                          key={tag}
                          className={cn(
                            "rounded px-1.5 py-px text-[10px] uppercase tracking-wide",
                            TAG_STYLE[tag],
                          )}
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                    <span className="hidden text-xs text-muted lg:block">{section.subtitle}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

SettingsNav.propTypes = {
  groups: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      title: PropTypes.string.isRequired,
      icon: PropTypes.string.isRequired,
      sections: PropTypes.arrayOf(PropTypes.string).isRequired,
    }),
  ).isRequired,
  sections: PropTypes.arrayOf(PropTypes.object).isRequired,
  activeId: PropTypes.string.isRequired,
  onSelect: PropTypes.func.isRequired,
};
