// YAN-372: user-level budgets (scopeType user, workspaceId NULL). Instance
// admin/owner only (instance.budgets.raise), re-checked live in the repo;
// non-admins get 403. Hidden (404) while the multi-user switch is off.
import { json } from "@/lib/users/userManagement.js";
import { badRequest, fail, gate, publicBudget, readBody } from "@/lib/users/budgetRoutes.js";
import { createBudget, listUserBudgets } from "@/lib/db/repos/budgetsRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const KEYS = ["window", "limitUsd", "limitTokens", "limitRequests", "softLimitPct"];

export async function GET(request, { params }) {
  const g = await gate(request);
  if (g.res) return g.res;
  try {
    const { id } = await params;
    const rows = await listUserBudgets(g.principal, { userId: id });
    return json({ budgets: rows.map(publicBudget) });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request, { params }) {
  const g = await gate(request, { body: true });
  if (g.res) return g.res;
  try {
    const { id } = await params;
    const body = await readBody(request, KEYS);
    if (!body) return badRequest();
    const budget = await createBudget(g.principal, {
      ...body,
      scopeType: "user",
      scopeId: id,
      userId: id,
    });
    return json({ budget: publicBudget(budget) }, 201);
  } catch (err) {
    return fail(err);
  }
}
