import { notFound } from "next/navigation";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch";

export const dynamic = "force-dynamic";

/** Admin screens do not exist while Users & teams is switched off. */
export default async function AdminLayout({ children }) {
  if (!(await isMultiUserEnabled())) notFound();
  return children;
}
