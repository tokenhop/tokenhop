// SSR render tests need live store state; real zustand serves getInitialState()
// on the server. Same store API, hook reads getState().
import { createStore } from "zustand/vanilla";

export function create(init) {
  const api = createStore(init);
  // biome-ignore lint/correctness/noComponentHookFactories: mirrors zustand's create() factory, which returns a new hook per store.
  const useStore = (selector = (s) => s) => selector(api.getState());
  return Object.assign(useStore, api);
}
