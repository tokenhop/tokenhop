/**
 * Live routes map geometry: three columns (clients → 9router → providers)
 * rendered as one plain SVG. Plain SVG wins over @xyflow/react here: the
 * board is a static three-column flow with bezier edges, no pan/zoom or node
 * dragging, and SVG keeps the text alternative trivially in sync.
 *
 * Layout is computed from row counts so the SVG scales with the data.
 */

export const NODE_W = { client: 170, hub: 96, provider: 190 };
export const NODE_H = 34;
export const HUB_H = 96;
export const ROW_GAP = 12;
export const TOP_PAD = 8;
export const GUTTER = 40;
export const SVG_W = NODE_W.client + GUTTER + NODE_W.hub + GUTTER + NODE_W.provider;

export const COLUMN_X = {
  client: 0,
  router: NODE_W.client + GUTTER,
  provider: NODE_W.client + GUTTER + NODE_W.hub + GUTTER,
};

/**
 * Height of one node column (rows plus padding).
 * @param {number} rows
 * @returns {number}
 */
export function columnHeight(rows) {
  return TOP_PAD * 2 + Math.max(rows, 1) * (NODE_H + ROW_GAP) - ROW_GAP;
}

/**
 * SVG height: the tallest column, never shorter than the 9router hub.
 * @param {number} rows
 * @returns {number}
 */
export function svgHeight(rows) {
  return Math.max(columnHeight(rows), TOP_PAD * 2 + HUB_H + 40);
}

/**
 * Vertical center of row i.
 * @param {number} i
 * @returns {number}
 */
export function rowCenter(i) {
  return TOP_PAD + i * (NODE_H + ROW_GAP) + NODE_H / 2;
}

/**
 * Cubic bezier from (x1,y1) to (x2,y2) with horizontal control handles.
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {string} SVG path d
 */
export function bezier(x1, y1, x2, y2) {
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}
