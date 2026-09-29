/**
 * Group an options array into consecutive runs sharing the same `group`
 * label, in first-seen order: each maximal run of adjacent options
 * with the same `group` becomes one entry, so a label that reappears later
 * starts a separate run instead of merging into the earlier one. Options
 * without `group` (label `null`) form ungrouped runs and render bare.
 * Pure, so callers can unit test grouping without rendering.
 * @param {Array<{ group?: string }>} [options]
 * @returns {Array<{ label: string|null, options: Array }>}
 */
export function groupSelectOptions(options = []) {
  const groups = [];
  for (const option of options) {
    const label = option.group || null;
    const current = groups[groups.length - 1];
    if (current && current.label === label) {
      current.options.push(option);
    } else {
      groups.push({ label, options: [option] });
    }
  }
  return groups;
}
