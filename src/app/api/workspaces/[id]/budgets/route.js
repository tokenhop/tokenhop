// YAN-372 (ADR-0007): workspace budget management. GET lists, POST creates
// (scopeType key|membership|workspace|grant). Hidden (404) while the
// multi-user switch is off. Browser session only. The repo re-checks scope
// ownership and live authority inside its transaction and writes the audit
// row — none here.
import { json } from "@/lib/users/userManagement.js";
import {
  badRequest,
  fail,
  gate,
  publicBudget,
  readBody,
  withSpent,
} from "@/lib/users/budgetRoutes.js";
import { createBudget, listBudgets } from "@/lib/db/repos/budgetsRepo.js";

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
  const g = await gate(request);
  if (g.res) return g.res;
  try {
    const { id } = await params;
    const rows = await listBudgets(g.principal, { workspaceId: id });
    return json({ budgets: await withSpent(rows) });
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
    const budget = await createBudget(g.principal, { ...body, workspaceId: id });
    return json({ budget: publicBudget(budget) }, 201);
  } catch (err) {
    return fail(err);
  }
}
