import PropTypes from "prop-types";

/**
 * In-page display H1 for pages that own their title (Home, provider detail).
 * Matches the shell Header title scale.
 */
export default function PageTitle({ children, titleRef }) {
  return (
    <h1
      ref={titleRef}
      tabIndex={titleRef ? -1 : undefined}
      className="font-display text-2xl font-bold tracking-[-0.02em] text-text lg:text-[42px] lg:leading-[1.05]"
    >
      {children}
    </h1>
  );
}

PageTitle.propTypes = {
  children: PropTypes.node.isRequired,
  titleRef: PropTypes.shape({ current: PropTypes.any }),
};
