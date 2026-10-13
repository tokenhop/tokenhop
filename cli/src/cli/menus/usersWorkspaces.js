const users = require("../api/usersClient");
const workspace = require("../api/workspaceSelection");
const { runUsers, runWorkspaces } = require("../commands/users");
const { describeError } = require("../commands/_runApi");
const { prompt, confirm, pause, selectMenu } = require("../utils/input");
const { showStatus } = require("../utils/display");
const { showMenuWithBack, showListMenu } = require("../utils/menuHelper");

async function fetchData(request, port) {
  try {
    const result = await request();
    if (result.success) return result.data;
    showStatus(describeError(result, port), "error");
  } catch (error) {
    showStatus(error.message, "error");
  }
  await pause();
  return null;
}

async function chooseRole(roles, breadcrumb) {
  const selected = await selectMenu(
    "Choose role",
    [{ label: "← Back" }, ...roles.map((label) => ({ label }))],
    0,
    "",
    "",
    breadcrumb,
  );
  return selected > 0 ? roles[selected - 1] : null;
}

async function runAction(command, args, port) {
  await command([...args, "--port", String(port)]);
  await pause();
}

// One selection controls provider/combo client scope and explicit key scope.
async function pickWorkspace(breadcrumb = []) {
  const choices = workspace.getWorkspaceChoices();
  if (!choices.length) {
    showStatus("No workspaces available. Check your workspace membership.", "error");
    await pause();
    return false;
  }
  const selected = await selectMenu(
    "Choose workspace",
    [
      { label: "← Back" },
      ...choices.map((w) => ({
        label: `${w.name || w.id}${w.id === workspace.getSelectedWorkspaceId() ? " (selected)" : ""}`,
      })),
    ],
    0,
    "",
    "Applies to API keys, providers and combos. Up/Down to choose; Enter to select; Esc to go back.",
    breadcrumb,
  );
  return selected > 0 && workspace.selectWorkspace(choices[selected - 1]?.id);
}

async function showUserActions(user, port, breadcrumb) {
  const name = user.displayName || user.username || user.email || user.id;
  await showMenuWithBack({
    title: name,
    breadcrumb: [...breadcrumb, name],
    refresh: () => fetchData(() => users.getUser(user.id), port),
    headerContent: (data) => {
      const current = data.user;
      return `ID: ${user.id}\nRole: ${current.instanceRole}\nStatus: ${current.status}`;
    },
    items: [
      {
        label: "Approve pending user",
        action: async () => runAction(runUsers, ["approve", user.id], port),
      },
      {
        label: "Change role",
        action: async () => {
          const role = await chooseRole(["admin", "user", "pending"], breadcrumb);
          if (role && (await confirm(`Change ${name}'s role to ${role}?`)))
            await runAction(runUsers, ["role", user.id, role], port);
        },
      },
      {
        label: "Disable user",
        action: async () => {
          if (await confirm(`Disable ${name}? Their access will be revoked.`))
            await runAction(runUsers, ["disable", user.id], port);
        },
      },
      {
        label: "Enable user",
        action: async () => runAction(runUsers, ["enable", user.id], port),
      },
      {
        label: "Reset password (hidden input)",
        action: async () => {
          if (await confirm(`Set a temporary password for ${name}?`))
            await runAction(runUsers, ["reset-password", user.id], port);
        },
      },
      {
        label: "Transfer ownership to this user",
        action: async () => {
          if (await confirm(`Make ${name} the instance owner? You will no longer be the owner.`)) {
            await runAction(runUsers, ["transfer-owner", user.id], port);
            return false;
          }
        },
      },
    ],
  });
}

async function showUsersMenu(port, breadcrumb) {
  let page = 1;
  let search = "";
  while (true) {
    const data = await fetchData(
      () => users.listUsers({ page: String(page), ...(search && { search }) }),
      port,
    );
    if (!data) return;
    const rows = data.users || [];
    const totalPages = data.pagination?.totalPages || 1;
    const controls = [
      { label: "← Back" },
      { label: "Search users" },
      { label: page > 1 ? "Previous page" : "Previous page (first page)" },
      { label: page < totalPages ? "Next page" : "Next page (last page)" },
    ];
    const selected = await selectMenu(
      "Users",
      [
        ...controls,
        ...rows.map((u) => ({
          label: `${u.displayName || u.username || u.email || u.id} [${u.instanceRole}] ${u.status} (${u.id})`,
        })),
      ],
      0,
      "",
      `Page ${page}/${totalPages}${search ? ` • Search: ${search}` : ""}\n${rows.length ? "Select a user to manage access." : "No users found."}`,
      breadcrumb,
    );
    if (selected <= 0) return;
    if (selected === 1) {
      search = await prompt("Search name or email (empty = all users): ");
      page = 1;
    } else if (selected === 2) page = Math.max(1, page - 1);
    else if (selected === 3) page = Math.min(totalPages, page + 1);
    else if (rows[selected - controls.length])
      await showUserActions(rows[selected - controls.length], port, breadcrumb);
  }
}

async function showMembersMenu(ws, port, breadcrumb) {
  await showListMenu({
    title: `Members: ${ws.name || ws.id}`,
    breadcrumb,
    headerContent:
      "Select a member to remove access. SSO-managed membership must be changed in your identity provider.",
    fetchItems: async () => {
      const data = await fetchData(() => users.listMembers(ws.id), port);
      return data ? { items: data.members || [] } : null;
    },
    formatItem: (m) =>
      `${m.displayName || m.userId} [${m.role}] ${m.source || "manual"} (${m.userId})`,
    onSelect: async (member) => {
      await showMenuWithBack({
        title: member.displayName || member.userId,
        breadcrumb: [...breadcrumb, member.userId],
        items: [
          {
            label: "Remove member",
            action: async () => {
              if (await confirm(`Remove ${member.userId} from ${ws.name || ws.id}?`)) {
                await runAction(runWorkspaces, ["remove-member", ws.id, member.userId], port);
                return false;
              }
            },
          },
        ],
      });
    },
    createAction: {
      label: "Add member",
      action: async () => {
        const userId = await prompt("User ID (empty = back; find IDs in Users): ");
        if (!userId) return;
        const role = await chooseRole(["manager", "member", "viewer"], breadcrumb);
        if (role)
          await runAction(runWorkspaces, ["add-member", ws.id, userId, "--role", role], port);
      },
    },
  });
}

async function showWorkspacesMenu(port, breadcrumb) {
  await showListMenu({
    title: "Workspaces",
    breadcrumb,
    headerContent: "Shared workspaces. Select a workspace to manage its members.",
    fetchItems: async () => {
      const data = await fetchData(() => users.listWorkspaces(), port);
      return data ? { items: data.workspaces || [] } : null;
    },
    formatItem: (w) => `${w.name} (${w.id}) • ${w.memberCount ?? 0} members`,
    onSelect: (ws) => showMembersMenu(ws, port, [...breadcrumb, ws.name || ws.id, "Members"]),
  });
}

async function showUsersWorkspacesMenu(port, breadcrumb = []) {
  await showMenuWithBack({
    title: "Users & workspaces",
    breadcrumb,
    headerContent: () => {
      const selected = workspace
        .getWorkspaceChoices()
        .find((w) => w.id === workspace.getSelectedWorkspaceId());
      return `Host-local CLI acts as instance owner.\nSelected workspace: ${selected?.name || selected?.id || "none"}`;
    },
    items: [
      { label: "Users", action: () => showUsersMenu(port, [...breadcrumb, "Users"]) },
      {
        label: "Workspaces & members",
        action: () => showWorkspacesMenu(port, [...breadcrumb, "Workspaces"]),
      },
    ],
  });
}

module.exports = { showUsersWorkspacesMenu, pickWorkspace };
