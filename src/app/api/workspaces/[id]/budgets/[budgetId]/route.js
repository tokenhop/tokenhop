// YAN-372: PATCH limits/softLimitPct of one workspace budget, DELETE it.
// Raising a limit or deleting needs instance.budgets.raise — enforced live in
// the repo (403 otherwise); scope/window are immutable.
import { json } from "@/lib/users/userManagement.js";
import { badRequest, fail, gate, publicBudget, readBody } from "@/lib/users/budgetRoutes.js";
import { deleteBudget, updateBudget } from "@/lib/db/repos/budgetsRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const KEYS = ["limitUsd", "limitTokens", "limitRequests", "softLimitPct"];

export async function PATCH(request, { params }) {
  const g = await gate(request, { body: true });
  if (g.res) return g.res;
  try {
    const { id, budgetId } = await params;
    const body = await readBody(request, KEYS);
    if (!body) return badRequest();
    const budget = await updateBudget(g.principal, { workspaceId: id, budgetId }, body);
    return json({ budget: publicBudget(budget) });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(request, { params }) {
  const g = await gate(request);
  if (g.res) return g.res;
  try {
    const { id, budgetId } = await params;
    const budget = await deleteBudget(g.principal, { workspaceId: id, budgetId });
    return json({ budget: publicBudget(budget) });
  } catch (err) {
    return fail(err);
  }
}
