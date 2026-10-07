// YAN-372: PATCH / DELETE one user-level budget. Instance admin/owner only,
// re-checked live in the repo.
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
    const budget = await updateBudget(g.principal, { userId: id, budgetId }, body);
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
    const budget = await deleteBudget(g.principal, { userId: id, budgetId });
    return json({ budget: publicBudget(budget) });
  } catch (err) {
    return fail(err);
  }
}
