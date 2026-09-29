/**
 * Initial stream state. Caller passes visibility at initialization; SSR assumes visible.
 * @param {{hidden: boolean, tab: "overview"|"logs"}} options
 * @returns {{hidden: boolean, tab: "overview"|"logs", open: boolean, needsCatchUp: boolean}}
 */
export function initialStreamState({ hidden, tab }) {
  return { hidden, tab, open: !hidden && tab === "overview", needsCatchUp: false };
}

/**
 * Track tab and document visibility; reopening requires one REST catch-up.
 * @param {ReturnType<typeof initialStreamState>} state
 * @param {{type: "visibility", hidden: boolean}|{type: "tab", tab: "overview"|"logs"}|{type: "caughtUp"}|{type: "reconnected"}} action
 * @returns {ReturnType<typeof initialStreamState>}
 */
export function streamReducer(state, action) {
  switch (action.type) {
    case "visibility":
    case "tab": {
      const hidden = action.type === "visibility" ? action.hidden : state.hidden;
      const tab = action.type === "tab" ? action.tab : state.tab;
      const open = !hidden && tab === "overview";
      if (hidden === state.hidden && tab === state.tab) return state;
      return { hidden, tab, open, needsCatchUp: state.needsCatchUp || (!state.open && open) };
    }
    case "caughtUp":
      return state.needsCatchUp ? { ...state, needsCatchUp: false } : state;
    case "reconnected":
      // An EventSource reopen after an error replays the backlog, but the
      // REST stats may have moved on: ask for one catch-up when the stream
      // is actually open.
      return state.open && !state.needsCatchUp ? { ...state, needsCatchUp: true } : state;
    default:
      throw new Error(`streamReducer: unknown action "${action?.type}"`);
  }
}
