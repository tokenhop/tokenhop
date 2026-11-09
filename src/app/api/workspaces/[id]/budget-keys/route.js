// YAN-1912: key picker for switch-off key budgets on Usage → Budgets. GET
// lists the budget workspace's keys (id, name, prefix) for the off-mode
// budget admin, including login-off local access, which `/api/keys` refuses.
// Same gate and live authority as the budget routes; `[id]` is `default` or
// the resolved budget workspace. 404 with the switch on: there the picker
// reads `/api/keys`, whose authority is unchanged.
import { json } from "@/lib/users/userManagement.js";
import { fail, gate } from "@/lib/users/budgetRoutes.js";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch.js";
import { listBudgetKeyOptions } from "@/lib/db/repos/budgetKeyOptionsRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request, { params }) {
  if (await isMultiUserEnabled()) return json({ error: "Not found" }, 404);
  const g = await gate(request, { offAllowed: true });
  if (g.res) return g.res;
  try {
    const { id } = await params;
    return json({ keys: await listBudgetKeyOptions(g.principal, { workspaceId: id }) });
  } catch (err) {
    if (err?.code === "NOT_FOUND") return json({ error: "Not found", code: "not_found" }, 404);
    return fail(err);
  }
}
