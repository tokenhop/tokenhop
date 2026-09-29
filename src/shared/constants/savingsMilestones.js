/**
 * Token-saver savings milestones (YAN-408): the cumulative-savings totals that
 * earn a one-time success toast, plus the literal toast copy. Only allowed
 * exclamation marks in the app (design-system §9).
 */

/** Ascending cumulative token milestones. */
export const SAVINGS_MILESTONES = [100000, 1000000, 10000000];

/** Toast copy per milestone. Sentence case, one exclamation mark. */
export const SAVINGS_MILESTONE_COPY = {
  100000: "You've saved 100k tokens with 9router!",
  1000000: "You've saved 1M tokens with 9router!",
  10000000: "You've saved 10M tokens with 9router!",
};
