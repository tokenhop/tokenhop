/**
 * Initial stream state. The caller passes visibility after mounting; SSR starts visible.
 * @param {{hidden: boolean, tab: "overview"|"logs"}} options
 * @returns {{hidden: boolean, tab: "overview"|"logs", open: boolean, needsCatchUp: boolean}}
 */
export function initialStreamState({ hidden, tab }) {
  return { hidden, tab, open: !hidden && tab === "overview", needsCatchUp: false };
}

/**
 * Track tab and document visibility; reopening requires one REST catch-up.
 * @param {ReturnType<typeof initialStreamState>} state
 * @param {{type: "visibility", hidden: boolean}|{type: "tab", tab: "overview"|"logs"}|{type: "caughtUp"}} action
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
    default:
      throw new Error(`streamReducer: unknown action "${action?.type}"`);
  }
}
