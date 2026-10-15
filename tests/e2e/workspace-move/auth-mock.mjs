// Only account state is synthetic; move capability helpers remain real.
export const status = {
  multiUserActive: true,
  loginMethod: "Password",
  principal: {
    role: "owner",
    activeWorkspaceId: "ws-personal",
    user: { username: "browser-fixture", email: "fixture@example.invalid" },
    workspaces: [
      { id: "ws-personal", name: "Personal", kind: "personal", role: "owner" },
      { id: "ws-shared", name: "Shared", kind: "shared", role: "owner" },
      { id: "default", name: "Default", kind: "default", role: "owner", isDefault: true },
    ],
  },
};
export function useAuthStatusState() {
  return { status, loaded: true };
}
export default function useAuthStatus() {
  return status;
}
