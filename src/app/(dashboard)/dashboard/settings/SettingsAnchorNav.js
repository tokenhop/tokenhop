"use client";

import PropTypes from "prop-types";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";

/**
 * Anchor navigation with IntersectionObserver scroll-spy. Renders
 * SegmentedControl-style pills that scroll smoothly to section headings.
 *
 * @param {object} props
 * @param {Array<{ id: string, title: string }>} props.sections
 */
export default function SettingsAnchorNav({ sections }) {
  const [activeId, setActiveId] = useState(sections[0]?.id || "");
  const observerRef = useRef(null);
  const sectionIds = sections.map((section) => section.id).join(",");

  useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) return;
    const elements = sectionIds
      .split(",")
      .map((id) => document.getElementById(id))
      .filter(Boolean);

    observerRef.current?.disconnect();
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the top-most intersecting section
        const intersecting = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (intersecting[0]?.target?.id) {
          setActiveId(intersecting[0].target.id);
        }
      },
      {
        rootMargin: "-20% 0px -60% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );
    observerRef.current = observer;
    for (const el of elements) observer.observe(el);

    return () => observer.disconnect();
  }, [sectionIds]);

  const handleClick = (e, id) => {
    e.preventDefault();
    setActiveId(id);
    const target = document.getElementById(id);
    if (target) {
      const scroller = target.closest("main")?.querySelector(".custom-scrollbar");
      if (scroller) {
        scroller.scrollTo({
          top:
            scroller.scrollTop +
            target.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            96,
          behavior: "smooth",
        });
      }
      if (window.history?.replaceState) {
        window.history.replaceState(null, "", `#${id}`);
      }
      // Move keyboard focus to the section heading for screen-reader users.
      const heading = target.querySelector("h2");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
    }
  };

  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-0 z-10 -mx-4 mb-6 overflow-x-auto border-b border-line bg-bg/90 px-4 py-2 backdrop-blur-md sm:mx-0 sm:rounded-xl sm:border sm:px-2"
    >
      <ul className="flex items-center gap-1 min-w-max">
        {sections.map(({ id, title }) => {
          const active = activeId === id;
          return (
            <li key={id}>
              <a
                href={`#${id}`}
                onClick={(e) => handleClick(e, id)}
                aria-current={active ? "location" : undefined}
                className={cn(
                  "inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                  "focus-visible:shadow-focus outline-none",
                  active ? "bg-coral-bg text-coral" : "text-muted hover:bg-raised hover:text-text",
                )}
              >
                {title}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

SettingsAnchorNav.propTypes = {
  sections: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      title: PropTypes.string.isRequired,
    }),
  ).isRequired,
};
