// YAN-372 (ADR-0007): workspace budget management. GET lists, POST creates
// (scopeType key|membership|workspace|grant). Browser session only. The repo
// re-checks scope ownership and live authority inside its transaction and
// writes the audit row — none here.
// YAN-1829 switch off: workspace and key budgets on Default only; `[id]` is
// `default` or the resolved id (the pending Default on pristine installs),
// other scopes answer 400 scope_unavailable. GET returns the resolved
// `workspaceId` (null before the first off-mode budget) in every mode.
import { json } from "@/lib/users/userManagement.js";
import {
  badRequest,
  fail,
  gate,
  publicBudget,
  readBody,
  withSpent,
} from "@/lib/users/budgetRoutes.js";
import { budgetWorkspaceId, createBudget, listBudgets } from "@/lib/db/repos/budgetsRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const KEYS = [
  "scopeType",
  "scopeId",
  "window",
  "limitUsd",
  "limitTokens",
  "limitRequests",
  "softLimitPct",
];

export async function GET(request, { params }) {
  const g = await gate(request, { offAllowed: true });
  if (g.res) return g.res;
  try {
    const { id } = await params;
    const rows = await listBudgets(g.principal, { workspaceId: id });
    const workspaceId = await budgetWorkspaceId(g.principal, id);
    return json({ budgets: await withSpent(rows), workspaceId });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request, { params }) {
  const g = await gate(request, { body: true, offAllowed: true });
  if (g.res) return g.res;
  try {
    const { id } = await params;
    const body = await readBody(request, KEYS);
    if (!body) return badRequest();
    const budget = await createBudget(g.principal, { ...body, workspaceId: id });
    return json({ budget: publicBudget(budget) }, 201);
  } catch (err) {
    return fail(err);
  }
}
