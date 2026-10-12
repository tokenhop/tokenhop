// Controllable auth status for SSR render tests: set globalThis.__authStatus.
export function useAuthStatusState() {
  return { status: globalThis.__authStatus ?? {}, loaded: globalThis.__authLoaded !== false };
}
export default function useAuthStatus() {
  return useAuthStatusState().status;
}
